// Disposable local Inbox QA. All state is temporary and Hermes history is a fixture.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createServer } from 'vite';
const root = await mkdtemp(join(tmpdir(), 'inbox-ui-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db.sqlite');
for (const [id, name] of [['default', 'Somboon'], ['somchai', 'Somchai'], ['som', 'Som']]) {
  const home = id === 'default' ? process.env.HERMES_HOME : join(process.env.HERMES_HOME, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), '{}');
  await writeFile(join(home, 'profile.yaml'), `displayName: ${name}\nactive: true\n`);
}
const { default: api, adapter } = await import('../../server/app.js');
const { default: db } = await import('../../server/db/index.js');
const { insertTask, updateTask, getAllTasks } = await import('../../server/db/queries.js');
const { createProject, grantProjectProfileAccess } = await import('../../server/db/projects.js');
const { startRun, discardRun } = await import('../../server/live-chat.js');
const { recordInteraction, markInteractionSettled } = await import('../../server/db/interactions.js');
const { createTaskAgentRun, finishTaskAgentRun } = await import('../../server/db/task-agent-runs.js');
const project = createProject({ name: 'Olympus', purpose: 'Local Inbox verification', managerProfileId: 'default', changedBy: 'fixture' });
grantProjectProfileAccess({ projectId: project.id, profileId: 'som', role: 'contribute', grantedBy: 'fixture' });
const question = insertTask({ title: 'Choose a homepage direction', status: 'in_progress', profile_name: 'som', project_id: project.id });
const { state: { runId } } = startRun(question.id, question.id, 'Create three homepage concepts');
recordInteraction({ taskId: question.id, profileName: 'som', olympusRunId: runId, interaction: {
  id: 'design-question', workerRunId: 'fixture-worker', kind: 'clarification', title: 'Which homepage should I develop?', expiresAt: 0,
  questions: [{ id: 'direction', question: 'Choose the direction to develop', choices: ['Editorial — warm and welcoming', 'Modern — clean and minimal', 'Bold — colorful and energetic'], multiSelect: false }],
} });
const review = insertTask({ title: 'Review the morning radio mix', status: 'in_review', profile_name: 'somchai' });
const website = insertTask({ title: 'Review Project sync improvements', status: 'in_review', project_id: project.id });
const failure = insertTask({ title: 'Finish the supplier comparison', status: 'in_progress' });
createTaskAgentRun({ taskId: failure.id, runId: 'failed-run', kind: 'chat', status: 'streaming', startedAt: Date.now() - 60000 });
finishTaskAgentRun('failed-run', 'error');
const healthy = insertTask({ title: 'Working quietly in the background', status: 'in_progress', profile_name: 'somchai' });
startRun(healthy.id, healthy.id, 'work');
adapter.getMessagePage = async (_sessionId, taskId) => ({ messages: [{ id: 'fixture-reply', task_id: taskId, role: 'assistant',
  content: taskId === review.id ? 'The new morning mix is ready.\n\n- Smoother transitions between songs\n- Shorter, more natural voice links\n\n[Download the preview](./morning-mix.mp3)' : taskId === failure.id ? 'The comparison is saved. I need an updated supplier price list to finish the recommendation.' : 'Project sync now shows the verified time and commit. The regression tests passed.', created_at: Date.now() - 300000 }], pageInfo: { hasOlder: false, olderCursor: null } });
adapter.getDefaults = async () => ({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'low', showReasoning: true, baseUrl: null, apiMode: null });
adapter.getModels = async () => ({ defaultModel: 'fixture-model', activeProvider: 'fixture', groups: [] }) as never;
adapter.getGoalStatus = async () => null;
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.getSessionMetadata = async () => null;
const app = express();
let unavailable = false;
app.use(express.json());
app.post('/api/fixture/availability', (req, res) => { unavailable = req.body.unavailable === true; res.json({ unavailable }); });
app.post('/api/fixture/resolve', (_req, res) => { markInteractionSettled('design-question', 'answered'); updateTask(review.id, { status: 'done' }); res.json({ ok: true }); });
app.get('/api/fixture/state', (_req, res) => res.json({ tasks: getAllTasks() }));
app.use('/api/inbox', (_req, res, next) => unavailable ? res.status(503).json({ error: 'Fixture offline' }) : next());
app.get('/api/scheduled-tasks', (_req, res) => res.json({ scheduledTasks: [] }));
app.use(api);
const vite = await createServer({ root: resolve('client'), configFile: resolve('client/vite.config.ts'), cacheDir: join(root, 'vite-cache'), server: { middlewareMode: true, hmr: { port: 4196 } }, appType: 'spa' });
app.use(vite.middlewares);
const server = app.listen(4195, '127.0.0.1', () => console.log('Inbox QA: http://127.0.0.1:4195/inbox?profile=default'));
process.on('SIGTERM', () => {
  getAllTasks().forEach(task => discardRun(task.id));
  server.closeAllConnections(); server.close();
  void vite.close().then(async () => { db.close(); await rm(root, { recursive: true, force: true }); process.exit(0); });
});
