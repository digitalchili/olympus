import { Router } from 'express';
import { getRunStatus } from '../live-chat.js';
import { getTask } from '../db/queries.js';
import {
  claimInteraction,
  getInteraction,
  listTaskInteractions,
  markInteractionDelivered,
  markInteractionDeliveryUnknown,
} from '../db/interactions.js';
import { requestProfile, requireTaskForProfile } from '../profile-context.js';
import { errorCode, isRecord, toErrorMessage } from '../errors.js';
import type { AgentAdapter } from '../adapters/types.js';
import type { Task } from '../../shared/types.js';
import { validateInteractionResponse } from '../../shared/interactions.js';

export function createInteractionRouter(adapter: AgentAdapter): Router {
  const router = Router();
  router.use('/:id', requireTaskForProfile(getTask));

  router.get('/:id/interactions', (req, res) => {
    const task = res.locals.task as Task;
    const profile = requestProfile(req).id;
    res.json({ interactions: listTaskInteractions(task.id, profile) });
  });

  router.post('/:id/interactions/:interactionId/respond', async (req, res) => {
    const task = res.locals.task as Task;
    const profile = requestProfile(req).id;
    const body = isRecord(req.body) ? req.body : {};
    if (Object.keys(body).some((key) => !['workerRunId', 'response'].includes(key))) {
      return res.status(400).json({ error: 'workerRunId and response are required', code: 'INVALID_INTERACTION_RESPONSE' });
    }
    const workerRunId = typeof body.workerRunId === 'string' ? body.workerRunId : '';
    if (!workerRunId || workerRunId.length > 160) {
      return res.status(400).json({ error: 'workerRunId is required', code: 'INVALID_INTERACTION_RESPONSE' });
    }
    if (!adapter.respondInteraction) {
      return res.status(503).json({ error: 'This agent adapter does not support interactive questions', code: 'INTERACTION_UNSUPPORTED' });
    }

    const interaction = getInteraction(req.params.interactionId);
    if (!interaction || interaction.taskId !== task.id || interaction.profileName !== profile || interaction.workerRunId !== workerRunId) {
      return res.status(409).json({ error: 'Interaction is no longer waiting in this task and turn', code: 'INTERACTION_STALE' });
    }
    const validation = validateInteractionResponse(interaction, body.response);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error, code: 'INVALID_INTERACTION_RESPONSE' });
    }

    const active = getRunStatus(task.id);
    if (!active || active.status !== 'streaming' || active.runId !== interaction.olympusRunId) {
      return res.status(409).json({ error: 'Interaction is no longer waiting in this task and turn', code: 'INTERACTION_STALE' });
    }

    const claimed = claimInteraction({
      taskId: task.id,
      profileName: profile,
      interactionId: interaction.id,
      workerRunId,
      olympusRunId: active.runId,
      response: validation.response,
    });
    if (!claimed) {
      return res.status(409).json({ error: 'Interaction is no longer waiting in this task and turn', code: 'INTERACTION_STALE' });
    }

    try {
      const result = await adapter.respondInteraction({
        taskId: task.id,
        interactionId: interaction.id,
        workerRunId,
        response: validation.response,
      });
      if (!result.accepted) throw new Error('Hermes rejected the interaction response');
      markInteractionDelivered(interaction.id, validation.settleStatus, validation.response);
      res.json({ accepted: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'interaction_stale') {
        markInteractionDeliveryUnknown(interaction.id, toErrorMessage(error, 'Interaction is stale'));
        return res.status(409).json({ error: toErrorMessage(error, 'Interaction is stale'), code: 'INTERACTION_STALE' });
      }
      markInteractionDeliveryUnknown(interaction.id, toErrorMessage(error, 'Could not deliver interaction response'));
      return res.status(503).json({ error: toErrorMessage(error, 'Could not deliver interaction response'), code: code ?? 'INTERACTION_DELIVERY_UNKNOWN' });
    }
  });

  return router;
}
