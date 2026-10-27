import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import app, { adapter, repositoryQueue } from '../server/app.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';
import { insertTask, getTask } from '../server/db/queries.js';
import { getLatestTaskAgentRun } from '../server/db/task-agent-runs.js';
import { getProjectEditorForTask } from '../server/db/project-cp.js';
import { repositoryOwner } from '../server/db/repository-queue.js';
import { readCodingEvidence } from '../server/coding-verification.js';
import { hasActiveTaskRun } from '../server/task-run-lifecycle.js';
import { discardRun } from '../server/live-chat.js';

const root = process.env.OLYMPUS_DISPATCH_HOME!;
const seed = join(root, 'seed'); const remote = join(root, 'remote.git');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
await mkdir(join(seed, '.olympus'), { recursive: true });
await writeFile(join(seed, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(1)']] }));
git(seed, 'init', '-b', 'main'); git(seed, 'add', '.');
git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline with unavailable checks');
git(root, 'clone', '--bare', seed, remote);
const original = git(seed, 'rev-parse', 'HEAD');
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Conversation queue', purpose: 'Read-only conversations must not run unrelated checks', managerProfileId: 'default', changedBy: 'test' });
upsertProjectRepositoryLink(project.id, 77, { id: 905, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: remote });
adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
adapter.chatStream = async function* (sessionId) {
  yield { type: 'text_delta', content: 'Noted. No code changes were requested or made.' };
  yield { type: 'done', sessionId };
};
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
try {
  for (const requested of [false, true]) {
    const task = insertTask({ title: requested ? 'Explicit checks' : 'Information only', status: 'in_progress', project_id: project.id });
    const response = await fetch(`${base}/${task.id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: requested ? 'Run the tests' : 'Just so you know, someone else is working on the security update. You do not need to change anything.' }) });
    assert.equal(response.status, 202, await response.text());
    for (let n = 0; n < 1000 && (hasActiveTaskRun(task.id) || !getLatestTaskAgentRun(task.id)?.completedAt); n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(getLatestTaskAgentRun(task.id)?.status, 'done');
    assert.equal((await readCodingEvidence(getTask(task.id)!))?.status, requested ? 'failed' : 'skipped');
    assert.equal(getTask(task.id)?.status, requested ? 'in_progress' : 'in_review');
    await repositoryQueue.tick();
    if (requested) {
      assert.equal(repositoryOwner('github:905')?.taskId, task.id, 'explicit failed checks still block');
      assert.match(getTask(task.id)?.repositoryQueue?.message ?? '', /Checks panel/);
      assert.equal(getTask(task.id)?.repositoryQueue?.waitingForTaskId, null, 'an owner never waits for itself');
    } else assert.equal(repositoryOwner('github:905'), undefined, 'the next task can start automatically after a conversation');
    const lease = getProjectEditorForTask(project.id, task.id)!;
    assert.equal(git(lease.workdir, 'rev-parse', 'HEAD'), original);
    assert.equal(await readFile(join(lease.workdir, '.olympus/verification.json'), 'utf8'), await readFile(join(seed, '.olympus/verification.json'), 'utf8'));
    discardRun(task.id);
  }
  assert.equal(git(remote, 'rev-parse', 'main'), original);
} finally { server.close(); await once(server, 'close'); }
console.log('Actual chat admission skips unrelated checks but preserves explicit check failures');
