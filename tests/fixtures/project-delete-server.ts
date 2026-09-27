// Disposable full-page deletion QA. No real Hermes, GitHub or installation state.
// Run: node --import tsx tests/fixtures/project-delete-server.ts
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createServer } from 'vite';

const root = await mkdtemp(join(tmpdir(), 'project-delete-ui-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db.sqlite');
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = join(root, 'projects');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
await mkdir(process.env.OLYMPUS_DISPATCH_PROJECT_ROOT, { recursive: true });
const sentinel = join(process.env.OLYMPUS_DISPATCH_PROJECT_ROOT, 'keep.txt');
await writeFile(sentinel, 'Preserve local work.\n');

const { default: api, adapter } = await import('../../server/app.js');
const { default: db } = await import('../../server/db/index.js');
const { createProject, getProject } = await import('../../server/db/projects.js');
const { insertTask, getTask } = await import('../../server/db/queries.js');
const project = createProject({ name: 'Delete Project QA', purpose: 'Check confirmation, errors and task deletion.', managerProfileId: 'default', changedBy: 'fixture' });
const task = insertTask({ title: 'Deleted QA task', status: 'done', project_id: project.id, workdir: process.env.OLYMPUS_DISPATCH_PROJECT_ROOT });
const data = join(process.env.OLYMPUS_DISPATCH_HOME, 'data');
const ownedDirectories = [
  join(data, 'project-checkouts', 'tasks', project.id, task.id),
  join(data, 'project-checkouts', 'baselines', `${project.id}-${'a'.repeat(24)}`),
  join(data, 'project-checkouts', project.id),
  join(data, 'project-references', project.id),
  join(process.env.OLYMPUS_DISPATCH_HOME, 'workspace', 'tasks', task.id),
  join(data, 'task-artifact-previews', 'tasks', createHash('sha256').update(task.id).digest('hex').slice(0, 32)),
];
for (const directory of ownedDirectories) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'owned.txt'), Buffer.alloc(64 * 1024, 'x'));
}
const readonlyDirectory = join(ownedDirectories[0], 'readonly');
await mkdir(readonlyDirectory);
await writeFile(join(readonlyDirectory, 'cleanup-retry.txt'), 'Make disk cleanup failure visible.');
let allowDelete = false;
adapter.getBackgroundWork = async () => ({ available: allowDelete, work: [], continuation: { status: 'none' } });
adapter.getDefaults = async () => ({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'low', showReasoning: true, baseUrl: null, apiMode: null });
adapter.getModels = async () => ({ defaultModel: 'fixture-model', activeProvider: 'fixture', groups: [] }) as never;
adapter.healthCheck = async () => true;
adapter.getGoalStatus = async () => null;
adapter.chatStream = async function* () { throw new Error('Task execution is disabled in this fixture.'); };

const app = express();
app.use(express.json());
app.get('/api/fixture/state', (_req, res) => res.json({ projectExists: Boolean(getProject(project.id)), taskExists: Boolean(getTask(task.id)), externalFilePreserved: existsSync(sentinel), ownedDirectoriesRemaining: ownedDirectories.filter(existsSync).length }));
app.post('/api/fixture/allow-delete', (_req, res) => { allowDelete = true; res.json({ ok: true }); });
app.post('/api/fixture/fail-cleanup', async (_req, res) => { await chmod(readonlyDirectory, 0o500); res.json({ ok: true }); });
app.post('/api/fixture/allow-cleanup', async (_req, res) => { if (existsSync(readonlyDirectory)) await chmod(readonlyDirectory, 0o700); res.json({ ok: true }); });
app.get('/api/studio/github/status', (_req, res) => res.json({ configured: false, installations: [] }));
app.get('/api/profiles/attention', (_req, res) => res.json({ profiles: [] }));
app.get('/api/scheduled-tasks', (_req, res) => res.json({ scheduledTasks: [] }));
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || (req.method === 'DELETE' && req.path === `/projects/${project.id}`)) return next();
  res.status(403).json({ error: 'Only the disposable Project may be deleted.' });
});
app.use(api);
const vite = await createServer({ root: resolve('client'), configFile: resolve('client/vite.config.ts'), cacheDir: join(root, 'vite-cache'), server: { middlewareMode: true, hmr: { host: '127.0.0.1', port: 4198 } }, appType: 'spa' });
app.use(vite.middlewares);
const server = app.listen(4197, '127.0.0.1');
await once(server, 'listening');
console.log(`Project deletion QA: http://127.0.0.1:4197/projects/${project.id}?tab=settings&profile=default`);

let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await vite.close();
  await adapter.stop();
  db.close();
  if (existsSync(readonlyDirectory)) await chmod(readonlyDirectory, 0o700);
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => void cleanup());
process.once('SIGINT', () => void cleanup());
