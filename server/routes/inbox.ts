import { Router } from 'express';
import type { AgentAdapter } from '../adapters/types.js';
import type { InboxPreview } from '../../shared/inbox.js';
import { inboxSnapshot, inboxTaskAccessible } from '../inbox.js';
import { localProfileRegistry } from '../local-profiles.js';
import { getTask } from '../db/queries.js';
import { getInteraction } from '../db/interactions.js';

export function createInboxRouter(adapter: Pick<AgentAdapter, 'getMessagePage'>, registry = localProfileRegistry): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', (_req, res) => {
    try { res.json({ items: inboxSnapshot(registry) }); }
    catch { res.status(503).json({ error: 'Could not refresh the Inbox. Try again.' }); }
  });
  router.get('/:taskId', async (req, res) => {
    try {
      const taskId = req.params.taskId;
      const task = getTask(taskId);
      if (!task || !inboxTaskAccessible(task, registry)) return res.status(404).json({ error: 'Task not found' });
      const item = inboxSnapshot(registry).find(item => item.taskId === taskId);
      if (!item || req.query.key !== item.key) return res.status(409).json({ error: 'This item has changed. Refresh the Inbox.' });
      const preview: InboxPreview = { item };
      if (item.interactionId) {
        const interaction = getInteraction(item.interactionId)!;
        preview.interaction = {
          id: interaction.id, workerRunId: interaction.workerRunId, kind: interaction.kind,
          title: interaction.title, questions: interaction.questions, command: interaction.command,
          reason: interaction.reason, expiresAt: interaction.expiresAt,
        };
      } else {
        try {
          const page = await adapter.getMessagePage(taskId, taskId, { limit: 10 });
          const reply = page.messages.filter(message => message.role === 'assistant' && message.content.trim()).at(-1);
          if (reply) preview.reply = { content: reply.content, created_at: reply.created_at };
        } catch { preview.historyUnavailable = true; }
      }
      // Profile, Project access or attention can change while Hermes loads history.
      const current = getTask(taskId);
      if (!current || !inboxTaskAccessible(current, registry)) return res.status(404).json({ error: 'Task not found' });
      if (!inboxSnapshot(registry).some(next => next.taskId === taskId && next.key === item.key)) {
        return res.status(409).json({ error: 'This item has changed. Refresh the Inbox.' });
      }
      res.json(preview);
    } catch {
      res.status(503).json({ error: 'Could not load the preview. Try again.' });
    }
  });
  return router;
}
