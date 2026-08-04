import { Router } from 'express';
import { getTasksForProfile, getTask, insertTask, updateTask, deleteTask, markTaskViewed } from '../db/queries.js';
import { broadcast } from '../events.js';
import { adapter } from '../app.js';
import { TASK_STATUSES } from '../../shared/types.js';
import type { TaskStatus } from '../../shared/types.js';
import { validateProjectWorkdir } from '../project-folders.js';
import { LocalProfileError } from '../local-profiles.js';
import { requestProfile } from '../profile-context.js';

export const tasksRouter = Router();

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

tasksRouter.get('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
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

async function enrichTaskTitle(taskId: string, fallbackTitle: string, description: string): Promise<void> {
  try {
    const { title } = await adapter.generateTitle(description);
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
    void enrichTaskTitle(task.id, resolvedTitle, description);
  }
});

tasksRouter.patch('/:id', async (req, res) => {
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

  const updated = updateTask(req.params.id, fields);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

tasksRouter.post('/:id/viewed', (req, res) => {
  const { task, changed } = markTaskViewed(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (changed) broadcast({ type: 'task_updated', task });
  res.json({ task });
});

tasksRouter.delete('/:id', (req, res) => {
  const deleted = deleteTask(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_deleted', taskId: req.params.id });
  res.json({ ok: true });
});

tasksRouter.post('/:id/move', (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});
