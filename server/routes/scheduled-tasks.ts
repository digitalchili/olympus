import { Router, type Request, type Response } from 'express';
import { errorCode, isRecord, toErrorMessage } from '../errors.js';
import type { ScheduledTask, ScheduledTaskInput } from '../../shared/types.js';
import type { AgentAdapter } from '../adapters/types.js';
import { listScheduledTaskRuns, getScheduledTaskRunContent } from '../scheduled-tasks/runs.js';
import { profileRequestGate, requestProfile, sendProfileError } from '../profile-context.js';

const SCHEDULED_TASKS_LIMIT = 100;
const SCHEDULED_TASK_RUNS_LIMIT = 50;

const SCHEDULED_TASK_INPUT_FIELDS = [
  'name',
  'prompt',
  'schedule',
  'deliver',
  'skills',
  'model',
  'provider',
  'baseUrl',
  'workdir',
  'repeat',
  'contextFrom',
] as const;

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function routeScheduledTaskId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function scheduledTaskInputFromBody(body: unknown): Partial<ScheduledTaskInput> {
  if (!isRecord(body)) return {};

  const input: Partial<ScheduledTaskInput> = {};
  for (const field of SCHEDULED_TASK_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      Object.assign(input, { [field]: body[field] });
    }
  }
  return input;
}

function workerStatus(error: unknown): number {
  const code = errorCode(error);
  if (code === 'bad_request') return 400;
  if (code === 'not_found') return 404;
  return 503;
}

function workerErrorFallback(error: unknown): string {
  return workerStatus(error) === 400 ? 'Invalid scheduled task' : 'Hermes scheduled tasks worker unavailable';
}

function sendScheduledTaskError(res: Response, error: unknown, fallback: string, status = 503): void {
  const profileError = sendProfileError(error);
  if (profileError) {
    res.status(profileError.status).json(profileError.body);
    return;
  }
  res.status(status).json({ error: toErrorMessage(error, fallback) });
}

export function createScheduledTasksRouter(adapter: AgentAdapter): Router {
  const router = Router();
  const mutationGate = profileRequestGate();

  router.get('/', async (req, res) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const parsedLimit = rawLimit ? Number.parseInt(String(rawLimit), 10) : SCHEDULED_TASKS_LIMIT;
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : SCHEDULED_TASKS_LIMIT;
      const scheduledTasks = await adapter.listScheduledTasks(includeDisabled, limit, requestProfile(req).id);
      res.json({ scheduledTasks });
    } catch (error) {
      sendScheduledTaskError(res, error, 'Hermes scheduled tasks worker unavailable');
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const scheduledTask = await adapter.getScheduledTask(req.params.id, requestProfile(req).id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ scheduledTask });
    } catch (error) {
      sendScheduledTaskError(res, error, 'Hermes scheduled tasks worker unavailable');
    }
  });

  router.post('/', mutationGate, async (req, res) => {
    const input = scheduledTaskInputFromBody(req.body);
    if (!hasText(input.prompt)) return res.status(400).json({ error: 'prompt is required' });
    if (!hasText(input.schedule)) return res.status(400).json({ error: 'schedule is required' });

    try {
      const scheduledTask = await adapter.createScheduledTask(input as ScheduledTaskInput, requestProfile(req).id);
      res.json({ scheduledTask });
    } catch (error) {
      const status = workerStatus(error);
      sendScheduledTaskError(res, error, workerErrorFallback(error), status);
    }
  });

  router.patch('/:id', mutationGate, async (req, res) => {
    const updates = scheduledTaskInputFromBody(req.body);
    if ('prompt' in updates && !hasText(updates.prompt)) {
      return res.status(400).json({ error: 'prompt cannot be empty' });
    }
    if ('schedule' in updates && !hasText(updates.schedule)) {
      return res.status(400).json({ error: 'schedule cannot be empty' });
    }

    try {
      const scheduledTask = await adapter.updateScheduledTask(routeScheduledTaskId(req), updates, requestProfile(req).id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ scheduledTask });
    } catch (error) {
      const status = workerStatus(error);
      sendScheduledTaskError(res, error, workerErrorFallback(error), status);
    }
  });

  router.get('/:id/runs', async (req, res) => {
    try {
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = rawLimit ? Number.parseInt(String(rawLimit), 10) : SCHEDULED_TASK_RUNS_LIMIT;
      const profile = requestProfile(req);
      const runs = await listScheduledTaskRuns(
        req.params.id,
        Number.isFinite(limit) ? limit : SCHEDULED_TASK_RUNS_LIMIT,
        profile.hermesHome,
      );
      res.json({ runs });
    } catch (error) {
      sendScheduledTaskError(res, error, 'Failed to list scheduled task runs', 500);
    }
  });

  router.get('/:id/runs/:runId/content', async (req, res) => {
    try {
      const content = await getScheduledTaskRunContent(req.params.id, req.params.runId, requestProfile(req).hermesHome);
      if (!content) return res.status(404).json({ error: 'Scheduled task run output not found' });
      res.json({ content });
    } catch (error) {
      sendScheduledTaskError(res, error, 'Failed to read scheduled task run', 500);
    }
  });

  async function scheduledTaskActionHandler(
    req: Request,
    res: Response,
    id: string,
    action: (id: string, profileId: string) => Promise<ScheduledTask | null>,
  ) {
    try {
      const scheduledTask = await action(id, requestProfile(req).id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ scheduledTask });
    } catch (error) {
      sendScheduledTaskError(res, error, 'Hermes scheduled tasks worker unavailable');
    }
  }

  router.post('/:id/pause', mutationGate, (req, res) => {
    const rawReason = req.body?.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
    scheduledTaskActionHandler(req, res, routeScheduledTaskId(req), (id, profileId) => adapter.pauseScheduledTask(id, reason, profileId));
  });

  router.post('/:id/resume', mutationGate, (req, res) => {
    scheduledTaskActionHandler(req, res, routeScheduledTaskId(req), (id, profileId) => adapter.resumeScheduledTask(id, profileId));
  });

  router.post('/:id/run', mutationGate, (req, res) => {
    scheduledTaskActionHandler(req, res, routeScheduledTaskId(req), (id, profileId) => adapter.runScheduledTask(id, profileId));
  });

  router.delete('/:id', mutationGate, async (req, res) => {
    try {
      const removed = await adapter.removeScheduledTask(routeScheduledTaskId(req), requestProfile(req).id);
      if (!removed) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ ok: true });
    } catch (error) {
      sendScheduledTaskError(res, error, 'Hermes scheduled tasks worker unavailable');
    }
  });

  return router;
}
