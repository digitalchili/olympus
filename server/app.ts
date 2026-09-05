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
import { createStorageRouter } from './routes/storage.js';
import { createUpdatesRouter } from './routes/updates.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createChannelsRouter } from './routes/channels.js';
import { createChannelHistoryRouter } from './routes/channel-history.js';
import { projectFoldersRouter } from './project-folders.js';
import { createTaskArtifactsRouter } from './task-artifacts.js';
import { createStudioRouter } from './routes/studio.js';
import { createProjectsRouter } from './routes/projects.js';
import { createProjectTaskWorkspaceRouter } from './routes/project-task-workspace.js';
import { createInteractionRouter } from './routes/interactions.js';
import { createProjectCpService } from './project-cp.js';
import { resolveOlympusDataDir } from './paths.js';
import { resolve } from 'node:path';
import { createGitHubAppGateway } from './studio/github-app.js';
import { createGitHubCredentialStore } from './studio/github-credentials.js';
import { getTask } from './db/queries.js';
import { listDelegationRunsForProfile, markProfileDelegationsUnknown, recordDelegationEvent } from './db/delegations.js';
import { normalizeDelegationEvent } from './delegation-events.js';
import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { ProfileAgentAdapter } from './adapters/routing.js';
import { initSSE, addClient, sendEvent, closeClientsForRestart, broadcast } from './events.js';
import { closeSubscribersForRestart, getRunStatuses, interruptActiveRuns } from './live-chat.js';
import { getAppVersion } from './version.js';
import { DrainController } from './drain.js';
import { createDrainRouter, maintenanceGuard } from './drain-http.js';
import { createActiveRequestTracker } from './active-requests.js';
import { getActiveTaskRunCount } from './task-run-lifecycle.js';
import { profileTaskRequestGate, requestProfile, sendProfileError, taskBelongsToProfile } from './profile-context.js';
import { createRuntimeLiveness } from './runtime-liveness.js';
import { operationalLog } from './observability.js';

const app = express();

const adapter = new ProfileAgentAdapter(new HermesWorkerAdapter());
adapter.onDelegationEvent((incoming) => {
  if (!incoming.profileId) return;
  const task = getTask(incoming.taskId);
  if (!task || (task.profile_name ?? 'default') !== incoming.profileId) return;
  const event = normalizeDelegationEvent(incoming.event);
  if (!event) return;
  const run = recordDelegationEvent({
    profileId: incoming.profileId,
    taskId: task.id,
    event,
  });
  if (run) broadcast({ type: 'delegation_run_updated', run }, task);
});
adapter.onDelegationReset((profileId) => {
  if (!profileId) return;
  for (const run of markProfileDelegationsUnknown(profileId)) {
    const task = getTask(run.task_id);
    if (task) broadcast({ type: 'delegation_run_updated', run }, task);
  }
});
const activeRequests = createActiveRequestTracker();
const drainController = new DrainController(() => getActiveTaskRunCount() + activeRequests.count());
const workerLiveness = createRuntimeLiveness({
  checkWorker: () => adapter.healthCheck(),
  onFailure: (status) => {
    operationalLog('worker_readiness_failed', status);
    for (const run of interruptActiveRuns('Hermes worker became unavailable. Your message was not completed; resend to retry.')) {
      broadcast({ type: 'task_run_updated', run });
    }
  },
});

app.get('/api/health', async (_req, res) => {
  const hermes = await adapter.healthCheck();
  res.json({ ok: true, hermes });
});

app.get('/api/ready', async (_req, res) => {
  const status = drainController.status();
  const probe = status.ready ? await workerLiveness.probe() : { ready: false, checked: false };
  res.status(status.ready && probe.ready ? 200 : 503).json({
    ...status,
    ready: status.ready && probe.ready,
    hermes: probe.ready,
    workerChecked: probe.checked,
    workerFailures: workerLiveness.status().failures,
    workerRetryAfter: workerLiveness.status().retryAfter,
  });
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
    sendEvent(res, { type: 'delegations_snapshot', runs: listDelegationRunsForProfile(profile.id) });
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

const studioGitHubGateway = createGitHubAppGateway({ credentialStore: createGitHubCredentialStore() });
const projectCp = createProjectCpService({ rootDir: resolve(resolveOlympusDataDir(), 'project-checkouts') });
app.use('/api/tasks', profileTaskRequestGate());
app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', createTaskArtifactsRouter({ getTask }));
app.use('/api/tasks', createTaskAgentSettingsRouter(adapter));
app.use('/api/tasks', createProjectTaskWorkspaceRouter({ projectCp, github: studioGitHubGateway }));
app.use('/api/tasks', createInteractionRouter(adapter));
app.use('/api/tasks', chatRouter);
app.use('/api/agent', createAgentRouter(adapter));
app.use('/api/installation', createInstallationRouter());
app.use('/api/storage', createStorageRouter());
app.use('/api/updates', createUpdatesRouter());
app.use('/api/projects', createProjectsRouter({ github: studioGitHubGateway, projectCp }));
app.use('/api/studio', createStudioRouter({
  github: studioGitHubGateway,
  publicUrl: process.env.OLYMPUS_STUDIO_PUBLIC_URL,
}));
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
