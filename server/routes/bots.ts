import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { ensureBotTask, getBotTask } from '../db/bots.js';
import { getBotMessage, listBotMessages, retryBotMessage } from '../db/bot-messages.js';
import { localProfileRegistry } from '../local-profiles.js';
import { profileTaskRequestGate, requestProfile, sendProfileError } from '../profile-context.js';
import { stopBotChain } from '../bot-messaging.js';
import { scheduleBotMessageDispatch } from '../bot-message-dispatcher.js';
import type { AgentAdapter } from '../adapters/types.js';
import { acquireProfileWork } from '../profile-deletion.js';
import { claimTaskOperation } from '../task-run-lifecycle.js';

export function createBotsRouter(adapter: Pick<AgentAdapter, 'interruptChat'>): Router {
  const router = Router();
  router.use(profileTaskRequestGate());
  router.get('/', (_req, res) => {
    res.json({ bots: localProfileRegistry.publicProfiles().map(profile => ({ profile, task: getBotTask(profile.id) ?? null })) });
  });
  router.post('/session', (req, res) => {
    try {
      const profile = requestProfile(req);
      mkdirSync(profile.workspaceDir, { recursive: true });
      res.json({ task: ensureBotTask(profile) });
    } catch (error) {
      const detail = sendProfileError(error);
      res.status(detail?.status ?? 503).json(detail?.body ?? { error: 'Could not open the Bot conversation' });
    }
  });
  router.get('/messages', (req, res) => {
    try { res.json({ messages: listBotMessages(requestProfile(req).id) }); }
    catch { res.status(503).json({ error: 'Could not load Bot messages' }); }
  });
  for (const action of ['retry', 'cancel'] as const) router.post(`/messages/:id/${action}`, async (req, res) => {
    const releases: Array<() => void> = [];
    try {
      const message = getBotMessage(req.params.id);
      const profileId = requestProfile(req).id;
      if (!message || (message.senderProfileId !== profileId && message.recipientProfileId !== profileId)) {
        return res.status(404).json({ error: 'Bot message not found' });
      }
      if (action === 'retry' && !['failed', 'interrupted'].includes(message.status)) return res.status(409).json({ error: 'This delivery cannot be retried' });
      if (action === 'cancel' && !['queued', 'running'].includes(message.status)) return res.status(409).json({ error: 'This delivery has already settled' });
      const releaseOperation = claimTaskOperation(`bot-exchange:${message.chainId}`);
      if (!releaseOperation) return res.status(409).json({ error: 'This Bot already has an operation in progress' });
      releases.push(releaseOperation);
      for (const id of new Set([message.senderProfileId, message.recipientProfileId])) releases.push(acquireProfileWork(id));
      await stopBotChain(message.chainId, adapter);
      if (action === 'retry') {
        localProfileRegistry.requireActive(message.senderProfileId);
        localProfileRegistry.requireActive(message.recipientProfileId);
        retryBotMessage(message.id);
        scheduleBotMessageDispatch();
      }
      return res.json({ message: getBotMessage(message.id) });
    } catch (error) {
      const detail = sendProfileError(error);
      return res.status(detail?.status ?? 409).json(detail?.body ?? { error: error instanceof Error ? error.message : 'Could not update Bot message' });
    } finally { releases.reverse().forEach(release => release()); }
  });
  return router;
}
