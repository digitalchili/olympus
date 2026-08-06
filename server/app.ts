import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter } from './routes/chat.js';
import { createAgentRouter, createTaskAgentSettingsRouter } from './routes/agent.js';
import { createScheduledTasksRouter } from './routes/scheduled-tasks.js';
import { skillsRouter } from './routes/skills.js';
import { filesRouter } from './routes/files.js';
import { searchRouter } from './routes/search.js';
import { createInstallationRouter } from './routes/installation.js';
import { createUpdatesRouter } from './routes/updates.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createChannelsRouter } from './routes/channels.js';
import { createChannelHistoryRouter } from './routes/channel-history.js';
import { projectFoldersRouter } from './project-folders.js';
import { createTaskArtifactsRouter } from './task-artifacts.js';
import { getTask } from './db/queries.js';
import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { ProfileAgentAdapter } from './adapters/routing.js';
import { initSSE, addClient, sendEvent, closeClientsForRestart } from './events.js';
import { closeSubscribersForRestart, getRunStatuses } from './live-chat.js';
import { getAppVersion } from './version.js';
import { DrainController } from './drain.js';
import { createDrainRouter, maintenanceGuard } from './drain-http.js';
import { createActiveRequestTracker } from './active-requests.js';
import { profileTaskRequestGate, requestProfile, sendProfileError, taskBelongsToProfile } from './profile-context.js';

const app = express();

const adapter = new ProfileAgentAdapter(new HermesWorkerAdapter());
const activeRequests = createActiveRequestTracker();
const drainController = new DrainController(() => getRunStatuses().filter((run) =>
  run.status === 'streaming' || run.status === 'compacting'
).length + activeRequests.count());

app.get('/api/health', async (_req, res) => {
  const hermes = await adapter.healthCheck();
  res.json({ ok: true, hermes });
});

app.get('/api/ready', async (_req, res) => {
  const status = drainController.status();
  const hermes = status.ready ? await adapter.healthCheck() : false;
  res.status(status.ready && hermes ? 200 : 503).json({ ...status, hermes });
});

app.use('/api/maintenance', createDrainRouter(drainController, undefined, () => {
  closeClientsForRestart();
  closeSubscribersForRestart();
}));

app.use(activeRequests.middleware);
app.use(maintenanceGuard(drainController));

app.get('/api/version', (_req, res) => {
  res.json(getAppVersion());
});

app.get('/api/events', (req, res) => {
  try {
    const profile = requestProfile(req);
    const runs = getRunStatuses().filter((run) => {
      const task = getTask(run.taskId);
      return task !== undefined && taskBelongsToProfile(task, profile);
    });
    initSSE(res);
    addClient(res, profile);
    sendEvent(res, { type: 'task_runs_snapshot', runs });
  } catch (error) {
    const profileError = sendProfileError(error);
    if (profileError) return res.status(profileError.status).json(profileError.body);
    res.status(500).json({ error: 'Could not resolve local Hermes profile' });
  }
});

app.use('/api/files', express.json({ limit: '25mb' }), filesRouter);
app.use('/api/project-folders', projectFoldersRouter);
app.use('/api/search', searchRouter);

app.use(express.json());

app.use('/api/tasks', profileTaskRequestGate());
app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', createTaskArtifactsRouter({ getTask }));
app.use('/api/tasks', createTaskAgentSettingsRouter(adapter));
app.use('/api/tasks', chatRouter);
app.use('/api/agent', createAgentRouter(adapter));
app.use('/api/installation', createInstallationRouter());
app.use('/api/updates', createUpdatesRouter());
app.use('/api/profiles', createProfilesRouter(adapter));
app.use('/api/channels', createChannelsRouter());
app.use('/api/channels', createChannelHistoryRouter());
app.use('/api/scheduled-tasks', createScheduledTasksRouter(adapter));
app.use('/api/skills', skillsRouter);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!res.headersSent && error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  next(error);
});

export { adapter, drainController };
export default app;
