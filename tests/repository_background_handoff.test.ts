import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRepositoryQueue } from '../server/repository-queue.js';
import { createRepositoryDevelopment } from '../server/repository-development.js';
import { createProjectCpService } from '../server/project-cp.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';
import { insertTask, getTask } from '../server/db/queries.js';
import { createTaskAgentRun, finishTaskAgentRun } from '../server/db/task-agent-runs.js';
import { repositoryOwner } from '../server/db/repository-queue.js';
import { putQueuedTaskMessage } from '../server/db/task-message-queue.js';
import { captureCodingBaseline, verifyCodingRun } from '../server/coding-verification.js';

const root = process.env.OLYMPUS_DISPATCH_HOME!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cp = createProjectCpService({ rootDir: join(root, 'checkouts') });
const development = createRepositoryDevelopment(join(root, 'checkouts'));
const queue = createRepositoryQueue({ rootDir: join(root, 'checkouts'), adapter: { async getBackgroundWork() { return { available: true, work: [] }; } } });
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
async function fixture(id: number, fail = false) {
  const seed = join(root, `seed-${id}`); await mkdir(join(seed, '.olympus'), { recursive: true });
  const hold = join(root, `hold-${id}`), entered = join(root, `entered-${id}`), release = join(root, `release-${id}`);
  const code = `const f=require('fs');if(f.existsSync(${JSON.stringify(hold)})){f.writeFileSync(${JSON.stringify(entered)},'yes');const t=setInterval(()=>{if(f.existsSync(${JSON.stringify(release)})){clearInterval(t);}},20);}else process.exit(${fail ? 1 : 0});`;
  await writeFile(join(seed, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', code]] }));
  git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Initial');
  const project = createProject({ name: `Repo ${id}`, purpose: 'Deferred check boundaries', managerProfileId: 'default', changedBy: 'test' });
  const link = upsertProjectRepositoryLink(project.id, 77, { id, name: `repo-${id}`, fullName: `fixture/repo-${id}`, owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid', cloneUrl: seed });
  const task = insertTask({ title: `Task ${id}`, status: 'in_progress', project_id: project.id });
  assert.equal(await queue.admit(task), true);
  const lease = await cp.prepareTask({ projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink: link, automaticHandoff: true });
  const runId = `run-${id}`;
  createTaskAgentRun({ taskId: task.id, runId, kind: 'chat', status: 'streaming', startedAt: Date.now() });
  await captureCodingBaseline(getTask(task.id)!, runId);
  await writeFile(join(lease.workdir, 'change.txt'), 'preserve this work');
  assert.equal(await verifyCodingRun(getTask(task.id)!, runId), !fail);
  finishTaskAgentRun(runId, 'done');
  const shared = await development.source(link, seed);
  return { task, lease, hold, entered, release, shared, initial: git(seed, 'rev-parse', 'HEAD') };
}
const slow = await fixture(9071), fast = await fixture(9072), failed = await fixture(9073, true);
await writeFile(slow.hold, 'hold');
const ticking = queue.tick();
try {
  for (let i = 0; i < 100 && (!existsSync(slow.entered) || repositoryOwner('github:9072')); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(slow.entered), 'slow repository reached its deferred check');
  assert.equal(repositoryOwner('github:9072'), undefined, 'an unrelated repository finishes without waiting for the slow check');
  assert.equal(repositoryOwner('github:9071')?.taskId, slow.task.id);
  putQueuedTaskMessage({ taskId: slow.task.id, id: 'arrived-during-check', content: 'Keep working from this saved source', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: Date.now(), updatedAt: Date.now() });
} finally { await writeFile(slow.release, 'release'); await ticking; }
assert.equal(repositoryOwner('github:9071')?.taskId, slow.task.id, 'new input arriving during checks retains ownership');
assert.equal(git(slow.shared.path, 'rev-parse', slow.shared.branch), slow.initial, 'new input prevents premature acceptance of the checked commit');
assert.equal(await readFile(join(slow.lease.workdir, 'change.txt'), 'utf8'), 'preserve this work');
assert.equal(git(failed.lease.workdir, 'rev-parse', 'HEAD'), failed.initial, 'failed evidence never triggers an automatic commit');
assert.equal(repositoryOwner('github:9073')?.taskId, failed.task.id);
assert.equal(git(failed.shared.path, 'rev-parse', failed.shared.branch), failed.initial, 'failed files never become another task source');
console.log('Deferred handoff checks preserve concurrent messages, independent repositories and failed work');
