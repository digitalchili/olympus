// Disposable browser fixture: real chat UI, routes and queue; no native agents.
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-steering-ui-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = join(root, 'projects');
for (const path of [process.env.HERMES_HOME, process.env.OLYMPUS_DISPATCH_PROJECT_ROOT]) await mkdir(path, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const { default: api, adapter } = await import('../../server/app.js');
const { default: db } = await import('../../server/db/index.js');
const { insertTask } = await import('../../server/db/queries.js');
const { putQueuedTaskMessage, getQueuedTaskMessage } = await import('../../server/db/task-message-queue.js');
const { startRun, getRun } = await import('../../server/live-chat.js');
const { createTaskAgentRun } = await import('../../server/db/task-agent-runs.js');
const tasks = ['Accept a pasted review', 'Keep a declined steer saved'].map(title => insertTask({ title, status: 'in_progress' }));
const attachment = join(root, 'state', 'workspace', 'uploads', 'clipboard-paste.txt');
await mkdir(join(root, 'state', 'workspace', 'uploads'), { recursive: true });
await writeFile(attachment, 'Synthetic review: use the new design.\n');
const content = `Please apply this pasted review.\n\n[Attached files:\n- ${attachment}]`;
for (const task of tasks) {
  const run = startRun(task.id, task.id, 'Work on the design.');
  createTaskAgentRun({ taskId: task.id, runId: run.snapshot.runId, kind: 'chat', status: 'streaming', startedAt: run.snapshot.startedAt });
  putQueuedTaskMessage({ id: `${task.id}-queue`, taskId: task.id, content, settings: {}, invitedProfileIds: [],
    collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: Date.now(), updatedAt: Date.now() });
}
const delivered: Array<{ taskId: string; content: string }> = [];
adapter.steerChat = async (taskId, message) => {
  await new Promise(resolve => setTimeout(resolve, 750));
  if (taskId !== tasks[0].id) return false;
  delivered.push({ taskId, content: message });
  return true;
};
adapter.healthCheck = async () => true;
adapter.getDefaults = async () => ({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'low', showReasoning: true, baseUrl: null, apiMode: null });
adapter.getModels = async () => ({ defaultModel: 'fixture-model', activeProvider: 'fixture', groups: [] }) as never;
adapter.getMessagePage = async () => ({ messages: [], pageInfo: { hasOlder: false, olderCursor: null } });
adapter.getSessionMetadata = async () => null;
adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
adapter.chatStream = async function* () { throw new Error('Model calls disabled in this fixture'); };
const app = express();
app.get('/api/fixture/state', (_req, res) => res.json({ delivered, tasks: tasks.map(task => ({
  id: task.id, queue: getQueuedTaskMessage(task.id), status: getRun(task.id)?.status,
  userMessages: getRun(task.id)?.messages.filter(message => message.role === 'user').length,
})) }));
app.get('/api/profiles/attention', (_req, res) => res.json({ profiles: [] }));
app.get('/api/studio/github/status', (_req, res) => res.json({ configured: false, installations: [] }));
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || tasks.some(task => [
    `/tasks/${task.id}/steer`, `/tasks/${task.id}/queued-message`, `/tasks/${task.id}/queued-message/${task.id}-queue`, `/tasks/${task.id}/viewed`,
  ].includes(req.path))) return next();
  res.status(403).json({ error: 'Only disposable queue and steering changes are enabled.' });
});
app.use(api);
const dist = resolve('dist/server/client/dist');
app.use(express.static(dist));
app.get(/.*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;
console.log(JSON.stringify({ urls: tasks.map(task => `http://127.0.0.1:${port}/tasks/${task.id}?profile=default`), port }));
process.once('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => { db.close(); void rm(root, { recursive: true, force: true }).then(() => process.exit()); });
});
