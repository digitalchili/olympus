import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import app, { adapter, repositoryQueue } from '../server/app.js';
import { createProjectCpService } from '../server/project-cp.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';
import { insertTask, getTask } from '../server/db/queries.js';
import { getLatestTaskAgentRun } from '../server/db/task-agent-runs.js';
import { repositoryOwner } from '../server/db/repository-queue.js';
import { getQueuedTaskMessage, putQueuedTaskMessage } from '../server/db/task-message-queue.js';
import { configureQueuedMessageDispatcher, createQueuedMessageDispatcher } from '../server/queued-message-dispatcher.js';
import { discardRun } from '../server/live-chat.js';
import { readCodingEvidence } from '../server/coding-verification.js';
import type { TaskBackgroundWork, StreamEvent } from '../server/adapters/types.js';

const root = process.env.OLYMPUS_DISPATCH_HOME!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const seed = join(root, 'seed'); const remote = join(root, 'remote.git');
await mkdir(seed); await mkdir(join(seed, '.olympus'));
git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid');
await writeFile(join(seed, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }));
await writeFile(join(seed, 'base.txt'), 'original'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Initial'); git(root, 'clone', '--bare', seed, remote);
const original = git(seed, 'rev-parse', 'HEAD');
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Background reply', purpose: 'Replies with a test service', managerProfileId: 'default', changedBy: 'test' });
const link = upsertProjectRepositoryLink(project.id, 77, { id: 9061, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: remote });
const a = insertTask({ title: 'Test database owner', status: 'in_progress', project_id: project.id });
const b = insertTask({ title: 'Next coding task', status: 'in_progress', project_id: project.id });
const cp = createProjectCpService({ rootDir: join(root, 'project-checkouts') });
const lease = await cp.prepareTask({ projectId: project.id, taskId: a.id, profileId: 'default', repositoryLink: link, automaticHandoff: true });
let service: ReturnType<typeof spawn> | undefined;
let inventory: TaskBackgroundWork = { available: true, work: [] };
adapter.getBackgroundWork = async id => id === a.id ? inventory : { available: true, work: [] };
const received: string[] = [];
adapter.chatStream = async function* (sessionId, content): AsyncIterable<StreamEvent> {
  received.push(content);
  if (received.length === 1) {
    await writeFile(join(lease.workdir, 'change.txt'), 'saved work');
    // A real long-lived service outlasts the completed reply, just like the
    // production test database. Only the native inventory boundary is faked.
    service = spawn(process.execPath, ['-e', 'require("http").createServer((q,s)=>s.end("alive")).listen(0,"127.0.0.1",()=>console.log("ready"))']);
    await once(service.stdout!, 'data');
    inventory = { available: true, work: [{ id: 'test-service', kind: 'process', status: 'running' }] };
    putQueuedTaskMessage({ taskId: a.id, id: 'saved-followup', content: 'Reply only: what did you find?', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: Date.now(), updatedAt: Date.now() });
    // A source refresh during the follow-up must not merge under the service.
    await writeFile(join(seed, 'upstream.txt'), 'new upstream'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Upstream'); git(seed, 'push', remote, 'main');
  }
  yield { type: 'text_delta', content: 'The requested reply is complete.' };
  yield { type: 'done', sessionId };
};
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/api/tasks`;
const post = (id: string, body: unknown) => fetch(`${url}/${id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const failures: unknown[] = [];
configureQueuedMessageDispatcher(createQueuedMessageDispatcher({
  load: getQueuedTaskMessage,
  isActive: id => ['streaming', 'compacting'].includes(getLatestTaskAgentRun(id)?.status ?? ''),
  deliver: async (id, message) => { const response = await post(id, { content: message.content, queuedMessageId: message.id }); assert.equal(response.status, 202, await response.text()); },
  onError: (_id, error) => failures.push(error),
}));
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), 'a finished reply and its saved follow-up must settle while the service remains alive');
}
try {
  assert.equal((await post(a.id, { content: 'Inspect with a temporary test service' })).status, 202);
  await waitFor(() => received.length === 2 && getLatestTaskAgentRun(a.id)?.status === 'done');
  assert.deepEqual(failures, []);
  assert.equal(getQueuedTaskMessage(a.id), undefined, 'queued follow-up delivered exactly once');
  assert.equal(getTask(a.id)?.status, 'in_review');
  assert.equal(service?.exitCode, null, 'reply completion never kills the service');
  assert.equal(git(lease.workdir, 'rev-parse', 'HEAD'), original, 'no commit or upstream merge while background work is active');
  assert.equal(await readFile(join(lease.workdir, 'change.txt'), 'utf8'), 'saved work');
  assert.equal((await (await fetch(`${url}/${a.id}/background-work?profile=default`)).json()).canStop, true);
  const runningProcesses = inventory;
  for (const unsafe of [
    { ...runningProcesses, available: false },
    { ...runningProcesses, work: [...runningProcesses.work, { id: 'child', kind: 'delegation' as const, status: 'running' }] },
    { ...runningProcesses, work: [...runningProcesses.work, { id: 'worker', kind: 'operation' as const, status: 'running' }] },
    { ...runningProcesses, continuation: { status: 'pending' as const } },
    { ...runningProcesses, checkpoint: { saved: true, source: 'task-continuation-journal', pendingDelegationIds: ['child'], undeliveredResultCount: 1 } },
  ]) {
    inventory = unsafe;
    const rejected = await post(a.id, { content: 'Must not start', reuseTaskWorkspace: true });
    assert.ok([409, 503].includes(rejected.status), 'children, operations, uncertain state and saved results keep normal admission guards');
    assert.equal(received.length, 2);
  }
  inventory = runningProcesses;
  assert.equal((await post(a.id, { content: 'Commit & Push' })).status, 409, 'chat shortcut cannot publish under a running command');
  assert.equal((await post(b.id, { content: 'Use the accepted work' })).status, 202);
  await repositoryQueue.tick();
  assert.equal(repositoryOwner('github:9061')?.taskId, a.id, 'other tasks cannot overlap the service owner');
  assert.equal(received.length, 2);
  assert.match(getTask(b.id)?.repositoryQueue?.message ?? '', /background/i);
  // Native completion unlocks a fresh checked commit and automatic handoff.
  service!.kill('SIGTERM'); await once(service!, 'exit');
  inventory = { available: true, work: [] };
  await repositoryQueue.tick();
  await waitFor(() => received.length === 3 && getLatestTaskAgentRun(b.id)?.status === 'done');
  const evidence = await readCodingEvidence(getTask(a.id)!);
  assert.equal(evidence?.status, 'passed');
  assert.equal(evidence?.source?.head, git(lease.workdir, 'rev-parse', 'HEAD'));
  assert.notEqual(evidence?.source?.head, original);
  assert.equal(await readFile(join(getTask(b.id)!.workdir!, 'change.txt'), 'utf8'), 'saved work');
  assert.equal(git(remote, 'rev-parse', 'main'), git(seed, 'rev-parse', 'HEAD'), 'handoff never publishes task changes');
} finally {
  inventory = { available: true, work: [] };
  if (service && service.exitCode === null && service.signalCode === null) { service.kill('SIGTERM'); await once(service, 'exit'); }
  configureQueuedMessageDispatcher({ schedule() {} });
  for (const id of [a.id, b.id]) discardRun(id);
  server.close(); await once(server, 'close');
}
console.log('Replies and queued follow-ups settle without killing services or releasing repository safety');
