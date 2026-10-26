import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectEditorLease, ProjectRepositoryLink, Task } from '../shared/types.js';
import { readCodingEvidence, sourceIdentity, verifyCodingRun } from './coding-verification.js';
import { listProjectVersions } from './db/project-cp.js';
import { repositoryKey } from './db/repository-queue.js';
import { buildProjectGitEnv } from './project-git-auth.js';

const exec = promisify(execFile);
const branch = 'olympus/development';
const ref = `refs/heads/${branch}`;
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd, env: buildProjectGitEnv({ baseEnv: process.env, cloneUrl: '' }), maxBuffer: 8 * 1024 * 1024,
    })).stdout.trim();
  } catch { throw new Error('Olympus could not safely prepare the next task’s code. Saved work is preserved.'); }
}
async function exists(path: string): Promise<boolean> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Development storage must not be a symbolic link'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function createRepositoryDevelopment(root: string) {
  const pathFor = (link: ProjectRepositoryLink) => join(root, 'development', createHash('sha256').update(repositoryKey(link)).digest('hex'));
  async function assertLease(lease: ProjectEditorLease): Promise<void> {
    if (await git(lease.workdir, 'branch', '--show-current') !== lease.branchName) throw new Error('This task’s code branch changed. Saved work is preserved; review it before continuing.');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const path = await git(lease.workdir, 'rev-parse', '--path-format=absolute', '--git-path', marker);
      if (await exists(path)) throw new Error('This task has an unfinished Git operation. Its saved work is preserved; finish that operation before continuing.');
    }
  }
  return {
    async source(link: ProjectRepositoryLink, baseline: string): Promise<{ path: string; branch: string }> {
      const path = pathFor(link);
      const parent = join(root, 'development');
      await exists(root); await mkdir(parent, { recursive: true }); await exists(parent);
      if (!(await exists(path))) {
        // This repository is server-owned, local, and bare: agents never work in it.
        try {
          await git(parent, 'clone', '--bare', '--no-hardlinks', '--template=', baseline, path);
          await git(path, 'update-ref', ref, await git(baseline, 'rev-parse', 'HEAD'));
          await git(path, 'remote', 'remove', 'origin');
        } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
      }
      await git(path, 'rev-parse', '--verify', ref);
      return { path, branch };
    },
    async updateTask(lease: ProjectEditorLease, link: ProjectRepositoryLink, baseline: string): Promise<void> {
      await assertLease(lease);
      for (const [source, sourceRef] of [[pathFor(link), ref], [baseline, 'HEAD']]) {
        await git(lease.workdir, 'fetch', '--no-tags', source, sourceRef);
        const sha = await git(lease.workdir, 'rev-parse', 'FETCH_HEAD');
        const ancestor = await git(lease.workdir, 'merge-base', 'HEAD', sha);
        if (ancestor === sha) continue;
        if (await git(lease.workdir, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('This task has saved changes from earlier work. They need to be checked before combining them with the latest code.');
        try { await git(lease.workdir, 'merge', '--no-edit', '--no-autostash', sha); }
        catch (error) {
          // Abort only the merge started here. Never discard the task’s own work.
          await git(lease.workdir, 'merge', '--abort').catch(() => {});
          throw error;
        }
      }
    },
    async checkpoint(lease: ProjectEditorLease): Promise<void> {
      await assertLease(lease);
      if (!(await git(lease.workdir, 'status', '--porcelain=v1', '--untracked-files=all'))) return;
      await git(lease.workdir, 'add', '--all', '--', '.');
      await git(lease.workdir, 'commit', '-m', 'Save task work before automatic checks');
    },
    async accept(task: Task, runId: string, lease: ProjectEditorLease, link: ProjectRepositoryLink): Promise<string> {
      await assertLease(lease);
      let evidence = await readCodingEvidence(task);
      const clean = !(await git(lease.workdir, 'status', '--porcelain=v1', '--untracked-files=all'));
      const identity = await sourceIdentity(lease.workdir);
      // Publication may commit the exact checked files after the turn. Never
      // rewrite its authorization fingerprint: verify that confirmed commit here.
      if (clean && evidence?.runId === runId && ['stale', 'skipped'].includes(evidence.status)
        && listProjectVersions(link.projectId).some(version => version.taskId === task.id && version.commitSha === identity.head)) {
        await verifyCodingRun(task, runId);
        evidence = await readCodingEvidence(task);
      }
      if (evidence?.runId !== runId || evidence.status !== 'passed' || !evidence.source) throw new Error('The previous task’s checks have not passed. Its saved work is safe.');
      if (task.workdir !== lease.workdir || !clean) throw new Error('The previous task’s code changed after its checks. Its saved work is safe.');
      if (identity.fingerprint !== evidence.source.fingerprint) throw new Error('The previous task’s checks no longer match its code. Its saved work is safe.');
      const path = pathFor(link);
      const before = await git(path, 'rev-parse', ref);
      if (before === identity.head) return before;
      await git(path, 'fetch', '--no-tags', lease.workdir, identity.head);
      if (await git(path, 'merge-base', before, identity.head) !== before) throw new Error('The previous task does not include the latest accepted work. Its saved work is safe.');
      // Compare-and-swap the exact accepted ref, never overwrite another handoff.
      await git(path, 'update-ref', ref, identity.head, before);
      return identity.head;
    },
  };
}
