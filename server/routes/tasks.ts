import { Router } from 'express';
import { getTasksForProfile, getTask, insertTask, updateTask, deleteTask, markTaskViewed } from '../db/queries.js';
import { broadcast } from '../events.js';
import { adapter } from '../app.js';
import { TASK_STATUSES } from '../../shared/types.js';
import type { Task, TaskStatus } from '../../shared/types.js';
import { validateProjectWorkdir } from '../project-folders.js';
import { LocalProfileError } from '../local-profiles.js';
import { requestProfile, requireTaskForProfile } from '../profile-context.js';
import { closeSubscribersForTasks, discardRun } from '../live-chat.js';
import { cancelTaskRunForDeletion } from '../task-run-lifecycle.js';
import { listDelegationRuns } from '../db/delegations.js';

export const tasksRouter = Router();
const requireTask = requireTaskForProfile(getTask);

const LOW_INFORMATION_TITLES = new Set(['?', 'hi', 'hello', 'hey', 'yo']);

tasksRouter.get('/', (req, res) => {
  try {
    const status = req.query.status as TaskStatus | undefined;
    const profile = requestProfile(req);
    res.json({ tasks: getTasksForProfile(profile.id, profile.isDefault, status) });
  } catch (error) {
    if (error instanceof LocalProfileError) return res.status(error.status).json({ error: error.message, code: error.code });
    res.status(500).json({ error: 'Could not load tasks' });
  }
});

tasksRouter.get('/:id', requireTask, (_req, res) => {
  const task = res.locals.task as Task;
  res.json({ task });
});

tasksRouter.get('/:id/delegations', requireTask, (req, res) => {
  const task = res.locals.task as Task;
  const profile = requestProfile(req);
  res.json({ runs: listDelegationRuns(task.id, profile.id) });
});

function generateTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  const normalizedFirstLine = firstLine.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim();
  if (!normalizedFirstLine || LOW_INFORMATION_TITLES.has(normalizedFirstLine)) return 'Untitled task';

  const firstSentence = firstLine.split(/[.!?]/)[0].trim();
  if (!firstSentence) return text.slice(0, 60).trim() || 'Untitled task';
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + '...';
}

async function enrichTaskTitle(taskId: string, fallbackTitle: string, description: string, profileId: string): Promise<void> {
  try {
    const { title } = await adapter.generateTitle(description, profileId);
    const cleaned = title.trim();
    if (!cleaned || cleaned === fallbackTitle) return;

    const current = getTask(taskId);
    if (!current || current.title !== fallbackTitle) return;

    const updated = updateTask(taskId, { title: cleaned });
    if (updated) broadcast({ type: 'task_updated', task: updated });
  } catch {
    // Best-effort: leave the fallback title in place if the LLM call fails.
  }
}

tasksRouter.post('/', async (req, res) => {
  const { description, title } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }

  let workdir: string | null;
  try {
    workdir = await validateProjectWorkdir(req.body.workdir);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project folder' });
  }

  const userTitle = typeof title === 'string' ? title.trim() : '';
  const resolvedTitle = userTitle || generateTitle(description);
  let profile;
  try {
    profile = requestProfile(req);
  } catch (error) {
    if (error instanceof LocalProfileError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Could not resolve local Hermes profile' });
  }
  const task = insertTask({
    title: resolvedTitle,
    description,
    status: 'in_progress',
    workdir,
    profile_name: profile.id,
    routing_source: 'manual',
  });
  broadcast({ type: 'task_created', task });
  res.status(201).json({ task });

  if (!userTitle) {
    void enrichTaskTitle(task.id, resolvedTitle, description, profile.id);
  }
});

tasksRouter.patch('/:id', requireTask, async (req, res) => {
  const task = res.locals.task as Task;
  const allowed = ['title', 'description', 'status'] as const;
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }
  if (req.body.workdir !== undefined) {
    try {
      fields.workdir = await validateProjectWorkdir(req.body.workdir);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project folder' });
    }
  }

  if (fields.status && !TASK_STATUSES.includes(fields.status as TaskStatus)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(task.id, fields);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

tasksRouter.post('/:id/viewed', requireTask, (_req, res) => {
  const requestedTask = res.locals.task as Task;
  const { task, changed } = markTaskViewed(requestedTask.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (changed) broadcast({ type: 'task_updated', task });
  res.json({ task });
});

tasksRouter.delete('/:id', requireTask, async (_req, res) => {
  const task = res.locals.task as Task;
  await cancelTaskRunForDeletion(task, adapter);
  discardRun(task.id);
  closeSubscribersForTasks([task.id]);
  const deleted = deleteTask(task.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_deleted', taskId: task.id }, task);
  res.json({ ok: true });
});

tasksRouter.post('/:id/move', requireTask, (req, res) => {
  const task = res.locals.task as Task;
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(task.id, { status });
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});
