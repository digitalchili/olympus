// Disposable UI fixture. Only synthetic credentials; no real Hermes or external services.
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createServer } from 'vite';
const root = await mkdtemp(join(tmpdir(), 'project-secrets-ui-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = join(root, 'projects');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await mkdir(process.env.OLYMPUS_DISPATCH_PROJECT_ROOT, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const { default: api, adapter } = await import('../../server/app.js');
const { default: db } = await import('../../server/db/index.js');
const { createProject } = await import('../../server/db/projects.js');
const { listProjectSecrets } = await import('../../server/db/project-secrets.js');
const { insertTask, getTask } = await import('../../server/db/queries.js');
const project = createProject({ name: 'Secret Entry QA', purpose: 'Disposable secret entry test', managerProfileId: 'default', changedBy: 'fixture' });
const task = insertTask({ title: 'Project secret chat QA', status: 'in_progress', project_id: project.id, workdir: process.env.OLYMPUS_DISPATCH_PROJECT_ROOT });
const inbox = insertTask({ title: 'Inbox secret chat QA', status: 'in_progress' });
let modelRequests = 0;
adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
adapter.getDefaults = async () => ({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'low', showReasoning: true, baseUrl: null, apiMode: null });
adapter.getModels = async () => ({ defaultModel: 'fixture-model', activeProvider: 'fixture', groups: [] }) as never;
adapter.healthCheck = async () => true;
adapter.getGoalStatus = async () => null;
const history = process.env.OLYMPUS_FIXTURE_HISTORY === '1' ? Array.from({ length: 85 }, (_, i) => ({
  id: `saved-${i}`, task_id: task.id, role: i % 2 ? 'assistant' as const : 'user' as const,
  content: `Saved message ${String(i + 1).padStart(2, '0')}: ${i % 2 ? 'Here is the design feedback.' : 'Please review this design.'}`,
  created_at: 1_790_000_000_000 + i * 1000,
})) : [];
if (history.length) db.prepare('UPDATE tasks SET last_agent_response_at = ? WHERE id = ?').run(Date.now(), task.id);
adapter.getMessages = async () => history;
adapter.getMessagePage = async (_id, _taskId, options) => {
  const end = options?.before ? Number(options.before) : history.length;
  const start = Math.max(0, end - (options?.limit ?? 40));
  return { messages: history.slice(start, end), pageInfo: { hasOlder: start > 0, olderCursor: start > 0 ? String(start) : null } };
};
adapter.getSessionMetadata = async () => null;
adapter.generateTitle = async () => { modelRequests++; throw new Error('Disabled in this fixture'); };
adapter.chatStream = async function* () { modelRequests++; throw new Error('Disabled in this fixture'); };
const app = express();
app.get('/api/fixture/state', (_req, res) => res.json({
  names: listProjectSecrets(project.id).map(secret => secret.name), modelRequests,
  taskCount: (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
  queueCount: (db.prepare('SELECT COUNT(*) AS n FROM task_message_queue').get() as { n: number }).n,
  inboxProject: getTask(inbox.id)?.project_id,
  plaintextInSecretRows: JSON.stringify(db.prepare('SELECT encrypted_value FROM project_secrets').all()).includes('synthetic-'),
}));
app.get('/api/studio/github/status', (_req, res) => res.json({ configured: false, installations: [] }));
app.get('/api/profiles/attention', (_req, res) => res.json({ profiles: [] }));
app.get('/api/scheduled-tasks', (_req, res) => res.json({ scheduledTasks: [] }));
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || (['PUT', 'DELETE'].includes(req.method) && req.path.startsWith(`/projects/${project.id}/secrets`))
    || (req.method === 'POST' && [task.id, inbox.id].some(id => req.path === `/tasks/${id}/viewed`))) return next();
  return res.status(403).json({ error: 'Only disposable Project secret changes are enabled.' });
});
app.use(api);
const vite = await createServer({ root: resolve('client'), configFile: resolve('client/vite.config.ts'), cacheDir: join(root, 'vite-cache'), server: { middlewareMode: true, hmr: { host: '127.0.0.1', port: 4208 } }, appType: 'spa' });
app.use(vite.middlewares);
const server = app.listen(4207, '127.0.0.1'); await once(server, 'listening');
console.log(JSON.stringify({ task: `http://127.0.0.1:4207/tasks/${task.id}?profile=default`, inbox: `http://127.0.0.1:4207/tasks/${inbox.id}?profile=default`, settings: `http://127.0.0.1:4207/projects/${project.id}?tab=settings&profile=default` }));
let stopping = false;
async function cleanup() {
  if (stopping) return; stopping = true;
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await vite.close(); await adapter.stop(); db.close(); await rm(root, { recursive: true, force: true }); process.exit(0);
}
process.once('SIGTERM', () => void cleanup()); process.once('SIGINT', () => void cleanup());
