import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunOptions, ProjectRunRespondRequest } from '../server/adapters/types.js';
const root = await mkdtemp(join(tmpdir(), 'olympus-secret-chat-runtime-'));
const hermes = join(root, 'hermes'); const work = join(root, 'work');
await mkdir(hermes); await mkdir(work);
await writeFile(join(hermes, 'config.yaml'), '{}\n');
await writeFile(join(hermes, 'profile.yaml'), 'displayName: Default\nactive: true\n');
process.env.HERMES_HOME = hermes;
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'test.db');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { createProject } = await import('../server/db/projects.js');
const { saveProjectSecrets } = await import('../server/db/project-secrets.js');
const { getRun, discardRun } = await import('../server/live-chat.js');
const project = createProject({ name: 'Integration', purpose: 'Local testing', managerProfileId: 'default', changedBy: 'test' });
const task = insertTask({ title: 'Run local check', status: 'in_progress', profile_name: 'default', project_id: project.id, workdir: work });
const value = 'private-integration-canary';
saveProjectSecrets(project.id, [{ name: 'TEST_API_KEY', value }]);
let receivedOptions: AgentRunOptions | undefined;
let response: ProjectRunRespondRequest | undefined;
let completed!: () => void;
const finished = new Promise<void>(resolve => { completed = resolve; });
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.respondProjectRun = async result => { response = result; };
adapter.chatStream = async function* (_session, _message, options) {
  receivedOptions = options;
  yield { type: 'project_run_requested', projectRun: { requestId: 'request', workerRunId: 'worker-run', command: 'printf "%s" "$TEST_API_KEY"', secrets: ['TEST_API_KEY'] } };
  yield { type: 'text_delta', content: 'Local check finished.' };
  yield { type: 'done', sessionId: task.id, interrupted: true };
  completed();
};
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
try {
  const accepted = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Run a local integration check.' }) });
  assert.equal(accepted.status, 202, await accepted.text());
  await finished;
  assert.equal(receivedOptions?.projectRun, true);
  assert.match(receivedOptions?.systemMessage ?? '', /TEST_API_KEY/);
  assert.equal(JSON.stringify(receivedOptions).includes(value), false, 'worker receives names only');
  assert.deepEqual(response?.result, { ok: true, exitCode: 0, output: '[redacted]', truncated: false });
  const live = JSON.stringify(getRun(task.id));
  assert.equal(live.includes(value), false);
  assert.equal(live.includes('project_run_requested'), false, 'private broker event is not a conversation message');
  assert.match(live, /Local check finished/);
  // A transport failure must stop the local child even while stream iteration awaits it.
  const crashed = insertTask({ title: 'Transport loss', status: 'in_progress', profile_name: 'default', project_id: project.id, workdir: work });
  let closeTransport: (() => void) | undefined;
  let staleResponses = 0;
  let crashFinished!: () => void;
  const crashDone = new Promise<void>(resolve => { crashFinished = resolve; });
  adapter.respondProjectRun = async () => { staleResponses++; };
  adapter.chatStream = async function* (_session, _message, options) {
    closeTransport = options?.onStreamClosed;
    yield { type: 'project_run_requested', projectRun: { requestId: 'crash-request', workerRunId: 'crash-run', command: 'echo ready > started.txt; sleep 60', secrets: ['TEST_API_KEY'] } };
    yield { type: 'error', error: 'Synthetic worker restart', code: 'worker_restarted' };
    crashFinished();
  };
  const crashRequest = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${crashed.id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Run a local check.' }) });
  assert.equal(crashRequest.status, 202, await crashRequest.text());
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(join(work, 'started.txt'), 'utf8').catch(() => '') === 'ready\n') { started = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(started, true);
  assert.ok(closeTransport);
  closeTransport();
  await crashDone;
  assert.equal(staleResponses, 0, 'no response is sent into a replacement worker');
  discardRun(crashed.id);

} finally {
  discardRun(task.id); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await adapter.stop(); db.close(); await rm(root, { recursive: true, force: true });
}
console.log('Saved Project secrets execute through chat without worker or live-history values');
