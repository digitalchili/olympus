import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { ProjectRepositoryLink } from '../shared/types.js';
import type { CodingEvidence } from '../shared/coding-evidence.js';
import type { RepositoryChange, RepositoryOverview } from '../shared/repository-releases.js';
import db from './db/index.js';
import { getAllTasks } from './db/queries.js';
import { getLatestProjectEditorForTask } from './db/project-cp.js';
import { listProjectRepositoryLinks } from './db/projects.js';
import { getLatestTaskAgentRun } from './db/task-agent-runs.js';
import { getQueuedTaskMessage } from './db/task-message-queue.js';
import { listRepositoryContributions, listRepositoryReleases } from './db/repository-releases.js';
import { repositoryKey, repositoryOwner } from './db/repository-queue.js';
import { createRepositoryDevelopment } from './repository-development.js';
import { canProfileAccessProject } from './project-access.js';
import { buildProjectGitEnv } from './project-git-auth.js';
import { sourceIdentity } from './coding-verification.js';

const exec = promisify(execFile);
export async function readRepositoryGit(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env: { ...buildProjectGitEnv({ baseEnv: process.env, cloneUrl: '' }), GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}
export async function isRepositoryAncestor(path: string, ancestor: string | null, head: string | null): Promise<boolean> {
  if (!ancestor || !head) return false;
  return readRepositoryGit(path, 'merge-base', '--is-ancestor', ancestor, head).then(() => true, () => false);
}

/** No fetch, index refresh, evidence updates or handoff repairs in this reader. */
export function createRepositoryInventory(rootDir: string) {
  const development = createRepositoryDevelopment(rootDir);
  return {
    async read(link: ProjectRepositoryLink, targetSha: string | null, actor: string | null = null): Promise<RepositoryOverview> {
      const key = repositoryKey(link), path = development.pathFor(link);
      const acceptedSha = await development.head(link);
      // A release may merge a newer main without changing the development ref.
      // Its immutable local objects prove ancestry after exact remote readback.
      const publishedPath = listRepositoryReleases(key).find(row => row.candidate?.headSha === targetSha)?.candidate?.workdir ?? path;
      const links = listProjectRepositoryLinks().filter(item => repositoryKey(item) === key);
      const projects = new Set(links.map(item => item.projectId));
      const tasks = getAllTasks().filter(task => task.project_id && projects.has(task.project_id));
      const contributions = listRepositoryContributions(key);
      const changes: RepositoryChange[] = [];
      let hasHiddenWork = false;
      for (const task of tasks) {
        const lease = getLatestProjectEditorForTask(task.project_id!, task.id);
        const run = getLatestTaskAgentRun(task.id), queue = getQueuedTaskMessage(task.id);
        const records = contributions.filter(row => row.taskId === task.id);
        if (actor && !canProfileAccessProject(task.project_id!, actor, 'view')) {
          if (lease || queue || records.length) hasHiddenWork = true;
          continue;
        }
        const base = { taskId: task.id, title: task.title, projectId: task.project_id!, profileId: task.profile_name || 'default' };
        for (const record of records) {
          if (!record.changedFiles.length || !await isRepositoryAncestor(path, record.commitSha, acceptedSha)
            || await isRepositoryAncestor(publishedPath, record.commitSha, targetSha)) continue;
          changes.push({ ...base, id: record.id, state: 'ready', reason: 'Checked and combined with the other accepted changes.',
            changedFiles: record.changedFiles, commitSha: record.commitSha, previousSha: record.previousSha, runId: record.runId, queueId: null });
        }
        const working = run && ['streaming', 'compacting'].includes(run.status);
        const waiting = repositoryOwner(key)?.taskId === task.id;
        const pending = { ...base, id: `task:${task.id}`, state: 'working' as const, changedFiles: [] as string[], commitSha: null,
          previousSha: null, runId: queue && !working ? null : run?.runId ?? null, queueId: queue?.id ?? null };
        if (working || queue) {
          changes.push({ ...pending, reason: queue ? 'A saved request is waiting to run.' : 'This task is still working. Its changes are saved.' });
          continue;
        }
        if (!lease) continue;
        try {
          const head = await readRepositoryGit(lease.workdir, 'rev-parse', 'HEAD');
          const dirty = await readRepositoryGit(lease.workdir, 'status', '--porcelain=v1', '--untracked-files=all');
          const accepted = await isRepositoryAncestor(path, head, acceptedSha);
          const published = await isRepositoryAncestor(publishedPath, head, targetSha);
          if (!dirty && published) continue;
          if (!dirty && accepted && records.some(row => row.commitSha === head)) continue;
          const changedFiles = [...new Set([
            ...(lease.baseSha ? (await readRepositoryGit(lease.workdir, 'diff', '--name-only', lease.baseSha, '--')).split('\n').filter(Boolean) : []),
            ...(await readRepositoryGit(lease.workdir, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean),
          ])];
          if (!dirty && head === lease.baseSha && !waiting) continue;
          // Prior releases had no contribution table. A clean commit in the
          // accepted source with matching executed evidence is still provable.
          const evidence = (db.prepare("SELECT evidence_json FROM coding_evidence WHERE task_id = ? AND json_extract(evidence_json, '$.status') = 'passed' ORDER BY updated_at DESC").all(task.id) as Array<{ evidence_json: string }>)
            .map(row => JSON.parse(row.evidence_json) as CodingEvidence).find(item => item.source?.head === head && item.baseline.head !== head);
          if (!dirty && accepted && evidence?.source && evidence.workdir === await realpath(lease.workdir)
            && (await sourceIdentity(lease.workdir)).fingerprint === evidence.source.fingerprint) {
            changes.push({ ...base, id: `legacy:${task.id}:${evidence.runId}`, state: 'ready', reason: 'Checked changes already combined in the shared development version.',
              changedFiles: (await readRepositoryGit(path, 'diff', '--name-only', evidence.baseline.head, head, '--')).split('\n').filter(Boolean),
              commitSha: head, previousSha: evidence.baseline.head, runId: evidence.runId, queueId: null });
            continue;
          }
          changes.push({ ...pending, state: run?.status === 'stopped' ? 'stopped' : 'needs_attention', changedFiles, commitSha:head, previousSha:lease.baseSha,
            reason: run?.status === 'stopped' ? 'Stopped — work saved. These changes are not included in a release.'
              : 'Saved changes have not been accepted yet. Open this task to finish its checks and handoff.' });
        } catch {
          changes.push({ ...pending, state: 'needs_attention', reason: 'This task’s saved folder could not be checked. Restore access before including it.' });
        }
      }
      const readyHeads = new Set(changes.filter(row=>row.state==='ready').map(row=>row.commitSha));
      const unverified = changes.filter(row=>row.state!=='ready' && row.commitSha && row.commitSha!==row.previousSha && !readyHeads.has(row.commitSha));
      for (const change of changes.filter(row=>row.state==='ready')) {
        const dependency = await Promise.all(unverified.map(async row=>await isRepositoryAncestor(path,row.commitSha,change.commitSha) ? row : null));
        const missing = dependency.find(Boolean);
        if (missing) { change.state='needs_attention'; change.reason=`Waiting for the saved changes in “${missing.title}” to be checked before publishing these together.`; }
      }
      return { repositoryKey: key, repositoryName: link.fullName, targetBranch: link.defaultBranch, targetSha, acceptedSha, hasHiddenWork, changes };
    },
  };
}
