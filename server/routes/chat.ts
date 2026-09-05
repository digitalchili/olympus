import { Router, type Request, type Response } from 'express';
import { contextFromTask, getTask, updateTask, touchTask, recordAgentResponse } from '../db/queries.js';
import {
  cancelCollaborationRun,
  completeCollaborationContribution,
  createCollaborationRun,
  grantPersistentCollaboration,
  getCollaborationRun,
  listCollaborationRuns,
  listPersistentCollaborationGrants,
  revokePersistentCollaborationGrant,
  startCollaborationPhase,
  updateCollaborationRun,
} from '../db/collaboration.js';
import { adapter } from '../app.js';
import { broadcast, initSSE } from '../events.js';
import {
  appendSystemMessage,
  appendSteeredUserMessage,
  appendUserMessage,
  applyEvent,
  broadcast as broadcastLive,
  finishRun,
  getRun,
  getRunContext,
  getRunStatus,
  sendSnapshot,
  startAssistantMessage,
  startCompactionRun,
  startGoalRun,
  startRun,
  subscribe,
  updateRunGoal,
  updateRunContext,
  updateRunStatus,
} from '../live-chat.js';
import { taskRunSettings, parseRunSettingsBody } from '../agent-settings.js';
import { TASK_AGENT_SYSTEM_PROMPT } from '../prompts/task-agent.js';
import { isRecord, toErrorMessage } from '../errors.js';
import { publishMessageAttachments, publishTaskAttachments } from '../task-artifacts.js';
import {
  chairCollaborationContext,
  collaborationTaskContext,
  collectContributors,
  contributorSystemMessage,
  isPrivateCollaborationEvent,
  parseCollaborationInvitationScope,
  reviewContributorMessage,
  validateCollaborationInvites,
} from '../collaboration.js';
import { LocalProfileError } from '../local-profiles.js';
import { acquireProfileWork } from '../profile-deletion.js';
import { requestProfile, requireTaskForProfile } from '../profile-context.js';
import { ProjectAccessError, requireProfileProjectAccess } from '../project-access.js';
import { RunWatchdogError, runWatchdogConfig, withRunWatchdog, type RunWatchdogReason } from '../run-watchdog.js';
import { activeCollaborations, trackTaskRun, type ActiveCollaboration } from '../task-run-lifecycle.js';
import { hasReviewableAssistantOutput, shouldPromoteTerminalRun } from '../run-settlement.js';
import { scheduleQueuedMessageDispatch } from '../queued-message-dispatcher.js';
import { consumeQueuedTaskMessage, deleteQueuedTaskMessage, getQueuedTaskMessage, putQueuedTaskMessage, restoreQueuedTaskMessage } from '../db/task-message-queue.js';
import { createTaskAgentRun, finishTaskAgentRun, getLatestTaskAgentRun, updateTaskAgentRunResolution } from '../db/task-agent-runs.js';
import { syncMessageAttachmentsToProjectReferences } from '../db/project-references.js';
import { recordInteraction, markInteractionSettled, closeRunInteractions, hasUnansweredInteractions } from '../db/interactions.js';
import { normalizeNativeInteraction } from '../interactions.js';
import type { StreamEvent } from '../adapters/types.js';
import { CHAT_RUN_MODES, DEFAULT_PROFILE_NAME, OLYMPUS_GOAL_MAX_TURNS, TASK_MESSAGE_PAGE_MAX_SIZE, TASK_MESSAGE_PAGE_SIZE, type ChatRunMode, type CollaborationContributionPhase, type CollaborationInvitationScope, type CollaborationRun, type CompactResult, type ContextUsage, type QueuedTaskMessage, type Task } from '../../shared/types.js';

export const chatRouter = Router();
chatRouter.use('/:id', requireTaskForProfile(getTask));

function taskProfileId(task: Task): string {
  return task.profile_name ?? DEFAULT_PROFILE_NAME;
}

function releaseProfileWorkWhenSettled(taskId: string, work: Promise<void>, release: () => void): void {
  void trackTaskRun(taskId, work).then(release, release);
}

async function withProfileWork<T>(profileId: string, work: () => Promise<T>): Promise<T> {
  const release = acquireProfileWork(profileId);
  try {
    return await work();
  } finally {
    release();
  }
}

function sendAdapterError(res: Response, error: unknown, fallback: string): void {
  res.status(503).json({ error: toErrorMessage(error, fallback) });
}

function hasNoSession(task: Task): boolean {
  if (task.last_agent_response_at !== null) return false;
  return getRunStatus(task.id)?.status !== 'streaming';
}

function messagePageQuery(query: Request['query']): { limit: number; before: string | null } {
  const rawLimit = query.limit;
  const rawBefore = query.before;
  if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))) {
    throw new LocalProfileError(400, 'limit must be an integer', 'BAD_MESSAGE_PAGE');
  }
  const limit = rawLimit === undefined ? TASK_MESSAGE_PAGE_SIZE : Number(rawLimit);
  if (limit < 1 || limit > TASK_MESSAGE_PAGE_MAX_SIZE) {
    throw new LocalProfileError(400, `limit must be between 1 and ${TASK_MESSAGE_PAGE_MAX_SIZE}`, 'BAD_MESSAGE_PAGE');
  }
  if (rawBefore !== undefined && (typeof rawBefore !== 'string' || rawBefore.length === 0)) {
    throw new LocalProfileError(400, 'before must be a non-empty cursor', 'BAD_MESSAGE_PAGE');
  }
  return { limit, before: typeof rawBefore === 'string' ? rawBefore : null };
}

function isTaskRunActive(status: ReturnType<typeof getRunStatus>): boolean {
  return status?.status === 'streaming' || status?.status === 'compacting';
}

function isInterruptibleRun(status: ReturnType<typeof getRunStatus>): boolean {
  return status?.status === 'streaming' && (status.kind === 'chat' || status.kind === 'goal');
}

function normalizeQueuedMessageSettings(message: QueuedTaskMessage): QueuedTaskMessage['settings'] {
  const settledRun = getRunStatus(message.taskId);
  if (settledRun?.kind === 'goal' && settledRun.goal?.status === 'done' && message.settings.mode === 'goal') {
    return { ...message.settings, mode: 'task' };
  }
  return message.settings;
}

function queuedMessageRequestBody(message: QueuedTaskMessage): Record<string, unknown> {
  return {
    content: message.content,
    settings: normalizeQueuedMessageSettings(message),
    invitedProfileIds: message.invitedProfileIds,
    collaborationScope: message.collaborationScope,
    confirmPersistentCollaboration: message.confirmPersistentCollaboration,
  };
}

function completeTaskRun(
  taskId: string,
  runId: string,
  status: 'done' | 'error',
  ttlMs: number,
  options?: Parameters<typeof updateRunStatus>[2],
): void {
  const updated = updateRunStatus(taskId, status, options);
  if (updated) {
    broadcast({ type: 'task_run_updated', run: updated });
    broadcastRunSnapshot(taskId);
  }
  finishRun(taskId, ttlMs, runId);
  scheduleQueuedMessageDispatch(taskId);
}

chatRouter.get('/:id/messages', async (req, res) => {
  const task = res.locals.task as Task;
  let pageQuery;
  try {
    pageQuery = messagePageQuery(req.query);
  } catch (error) {
    if (error instanceof LocalProfileError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Could not resolve local Hermes profile' });
  }
  const liveContext = getRunContext(task.id);
  const context = liveContext !== undefined ? liveContext : contextFromTask(task);
  const latestAgentRun = getLatestTaskAgentRun(task.id) ?? null;
  if (hasNoSession(task)) {
    return res.json({
      messages: [],
      pageInfo: { hasOlder: false, olderCursor: null },
      context,
      ...(latestAgentRun ? { latestAgentRun } : {}),
    });
  }

  try {
    const page = await adapter.getMessagePage(task.id, task.id, pageQuery);
    const messages = await publishMessageAttachments(task, page.messages);
    res.json({
      messages,
      pageInfo: page.pageInfo,
      context,
      ...(latestAgentRun ? { latestAgentRun } : {}),
    });
  } catch (error) {
    sendAdapterError(res, error, 'Hermes session history unavailable');
  }
});

chatRouter.get('/:id/collaborations', (req, res) => {
  const task = res.locals.task as Task;
  res.json({ runs: listCollaborationRuns(task.id) });
});

chatRouter.get('/:id/collaboration-grants', (_req, res) => {
  const task = res.locals.task as Task;
  res.json({ grants: listPersistentCollaborationGrants({ taskId: task.id, projectId: task.project_id }) });
});

chatRouter.delete('/:id/collaboration-grants/:scope/:profileId', (req, res) => {
  const task = res.locals.task as Task;
  const scope = req.params.scope;
  if (scope !== 'task' && scope !== 'project') {
    return res.status(400).json({ error: 'scope must be task or project', code: 'INVALID_COLLABORATION_SCOPE' });
  }
  try {
    const scopeId = scope === 'task' ? task.id : task.project_id;
    if (!scopeId) {
      return res.status(400).json({ error: 'This task is not linked to a Project', code: 'PROJECT_REQUIRED' });
    }
    if (scope === 'project') requireProfileProjectAccess(scopeId, requestProfile(req).id, 'manage');
    const revoked = revokePersistentCollaborationGrant(scope, scopeId, req.params.profileId);
    return res.json({ revoked });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Could not revoke collaboration grant' });
  }
});

chatRouter.get('/:id/session', async (req, res) => {
  const task = res.locals.task as Task;
  if (hasNoSession(task)) return res.json({ session: null });

  try {
    const session = await adapter.getSessionMetadata(task.id);
    res.json({ session });
  } catch (error) {
    sendAdapterError(res, error, 'Hermes session metadata unavailable');
  }
});

const DONE_SNAPSHOT_TTL_MS = 30_000;
const ERROR_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

function parseChatRunMode(body: unknown): ChatRunMode {
  const record = isRecord(body) ? body : {};
  const settings = isRecord(record.settings) ? record.settings : {};
  const mode = settings.mode ?? record.mode ?? 'task';
  if (CHAT_RUN_MODES.includes(mode as ChatRunMode)) return mode as ChatRunMode;
  throw new Error(`mode must be one of: ${CHAT_RUN_MODES.join(', ')}`);
}

function broadcastRunSnapshot(taskId: string): void {
  const liveRun = getRun(taskId);
  if (liveRun) broadcastLive(taskId, { type: 'snapshot', run: liveRun });
}

interface StreamChatTurnResult {
  responseText: string;
  sawDone: boolean;
  context?: ContextUsage | null;
  hadError: boolean;
  // Only consumed by the goal loop; the chat path learns it stopped via the
  // `done` event reaching applyEvent (completeOnDone=true sets status 'stopped').
  interrupted: boolean;
  pendingSteer?: string;
}

function recordCompletedAgentRun(taskId: string, context: ContextUsage | null): Task | undefined {
  const updated = recordAgentResponse(taskId, Date.now(), context);
  if (updated && updated.status === 'in_progress') {
    return updateTask(taskId, { status: 'in_review' });
  }
  return updated;
}

function settleRun(taskId: string, runId: string, context: ContextUsage | null): void {
  const status = getRunStatus(taskId);
  const run = getRun(taskId);
  if (run?.modelResolution) updateTaskAgentRunResolution(runId, run.modelResolution);
  finishTaskAgentRun(runId, status?.status ?? 'error');
  if (status) broadcast({ type: 'task_run_updated', run: status });

  const hasAssistantOutput = hasReviewableAssistantOutput(run?.messages ?? []);
  if (status && !hasUnansweredInteractions(taskId, runId) && shouldPromoteTerminalRun(status.status, hasAssistantOutput)) {
    const updated = recordCompletedAgentRun(taskId, context);
    if (updated) broadcast({ type: 'task_updated', task: updated });
  } else {
    touchTask(taskId);
  }

  const ttl = status?.status === 'error' ? ERROR_SNAPSHOT_TTL_MS : DONE_SNAPSHOT_TTL_MS;
  finishRun(taskId, ttl, runId);
  scheduleQueuedMessageDispatch(taskId);
}

function taskSystemMessage(task: Task, supplemental = ''): string {
  const base = !task.workdir
    ? TASK_AGENT_SYSTEM_PROMPT
    : `${TASK_AGENT_SYSTEM_PROMPT}\n\n<workspace>\n  <path>${task.workdir}</path>\n  <rule>Use this as the project root. Keep file and terminal work inside it; begin shell commands with cd ${JSON.stringify(task.workdir)} && when needed.</rule>\n</workspace>`;
  return `${base}${supplemental}`;
}

async function streamChatTurn(
  runTask: Task,
  sessionId: string,
  content: string,
  options: {
    completeOnDone: boolean;
    captureResponseText?: boolean;
    supplementalSystemMessage?: string;
    hideInternalEvents?: boolean;
  },
): Promise<StreamChatTurnResult> {
  let sawDone = false;
  let doneContext: ContextUsage | null | undefined;
  let responseText = '';
  let hadError = false;
  let interrupted = false;
  let pendingSteer: string | undefined;
  const interactionRunId = getRunStatus(runTask.id)?.runId;
  const humanWaits = new Map<string, number>();

  try {
    const stream = withRunWatchdog(adapter.chatStream(sessionId, content, {
      systemMessage: taskSystemMessage(runTask, options.supplementalSystemMessage),
      settings: taskRunSettings(runTask),
      task: { id: runTask.id, title: runTask.title, workdir: runTask.workdir },
    }), {
      ...runWatchdogConfig(),
      pauseUntil: () => humanWaits.size ? Math.max(...humanWaits.values()) : null,
      onTimeout: async (reason: RunWatchdogReason) => {
        const message = reason === 'idle'
          ? 'Stopped automatically because the run stopped producing activity.'
          : 'Stopped automatically because the run exceeded the Olympus runtime limit.';
        await adapter.interruptChat(sessionId, message);
      },
    });

    for await (const rawEvent of stream) {
      let event = rawEvent;
      if (options.hideInternalEvents && isPrivateCollaborationEvent(event.type)) {
        continue;
      }
      if (rawEvent.type === 'done') {
        const run = getRun(runTask.id);
        const assistant = [...(run?.messages ?? [])].reverse().find((message) => message.role === 'assistant');
        const attachments = assistant ? await publishTaskAttachments(runTask, assistant.content) : [];
        if (attachments.length > 0) event = { ...rawEvent, attachments };
      }
      if (event.type === 'interaction_requested') {
        const activeRun = getRunStatus(runTask.id);
        const interaction = normalizeNativeInteraction(event.interaction, event.interaction?.workerRunId ?? '');
        if (interaction && activeRun && activeRun.runId === interactionRunId) {
          recordInteraction({
            taskId: runTask.id,
            profileName: taskProfileId(runTask),
            olympusRunId: activeRun.runId,
            interaction,
          });
          humanWaits.set(interaction.id, interaction.expiresAt);
          broadcastLive(runTask.id, event);
        }
        continue;
      }
      if (event.type === 'interaction_settled') {
        if (event.interactionId && event.interactionStatus && humanWaits.has(event.interactionId)) {
          markInteractionSettled(event.interactionId, event.interactionStatus);
          humanWaits.delete(event.interactionId);
        }
        broadcastLive(runTask.id, event);
        continue;
      }
      if (options.captureResponseText && event.type === 'text_delta' && event.content) {
        responseText += event.content;
      }
      if (event.type === 'done') {
        sawDone = true;
        doneContext = event.context;
        if (event.interrupted) interrupted = true;
        const unappliedSteer = event.pendingSteer?.trim();
        if (unappliedSteer) pendingSteer = unappliedSteer;
        if (!options.completeOnDone || pendingSteer) {
          updateRunContext(runTask.id, event.context, event.sessionId);
          continue;
        }
      }
      if (event.type === 'error') {
        hadError = true;
      }
      if (event.modelResolution) {
        const activeRunId = getRun(runTask.id)?.runId;
        if (activeRunId) updateTaskAgentRunResolution(activeRunId, event.modelResolution);
      }
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }
  } catch (error) {
    hadError = true;
    const event: StreamEvent = {
      type: 'error',
      error: toErrorMessage(error, 'Hermes chat stream failed'),
      code: error instanceof RunWatchdogError ? error.code : undefined,
    };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
  }

  if (interactionRunId) closeRunInteractions(runTask.id, interactionRunId);
  const finalRun = getRunStatus(runTask.id);
  if (!sawDone && !hadError && finalRun?.status === 'streaming') {
    if (options.completeOnDone) {
      const event: StreamEvent = { type: 'done', sessionId, context: doneContext };
      sawDone = true;
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    } else {
      hadError = true;
      const event: StreamEvent = { type: 'error', error: 'Hermes chat stream ended before completion' };
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }
  }

  return { responseText, sawDone, context: doneContext, hadError, interrupted, pendingSteer };
}

async function consumeChatRun(runTask: Task, sessionId: string, content: string, runId: string): Promise<void> {
  let turnContent = content;
  let finalContext: ContextUsage | null | undefined;
  while (true) {
    const result = await streamChatTurn(runTask, sessionId, turnContent, { completeOnDone: true });
    if (result.context !== undefined) finalContext = result.context;
    if (!result.pendingSteer || result.hadError || result.interrupted) break;
    turnContent = result.pendingSteer;
  }
  try {
    settleRun(runTask.id, runId, finalContext ?? null);
  } catch {
    finishRun(runTask.id, ERROR_SNAPSHOT_TTL_MS, runId);
  }
}

function visiblePhaseResults(
  collaboration: CollaborationRun,
  phase: CollaborationContributionPhase,
) {
  return collaboration.contributions
    .filter((contribution) => contribution.phase === phase)
    .map((contribution) => ({
      profileId: contribution.profile_id,
      label: contribution.profile_label,
      content: contribution.content,
      error: contribution.error,
    }));
}

async function collectCollaborationPhase(
  runTask: Task,
  collaboration: CollaborationRun,
  phase: CollaborationContributionPhase,
  active: ActiveCollaboration,
  taskContext: string,
): Promise<void> {
  const proposals = visiblePhaseResults(collaboration, 'proposal');
  const contributions = collaboration.contributions.filter((item) => item.phase === phase && item.status === 'running');
  await collectContributors(
    contributions.map((contribution) => ({
      id: contribution.id,
      profileId: contribution.profile_id,
      sessionId: contribution.session_id,
      message: taskContext + (phase === 'proposal'
        ? `Current collaboration question:\n${collaboration.question}`
        : reviewContributorMessage(collaboration.question, contribution.profile_id, proposals)),
      options: { systemMessage: contributorSystemMessage(runTask.workdir, phase) },
    })),
    async (invocation) => withProfileWork(invocation.profileId, () => adapter.chatForProfile(
      invocation.profileId,
      invocation.sessionId,
      invocation.message,
      invocation.options,
    )),
    (result) => {
      if (active.cancelled) return;
      const text = result.text?.trim();
      completeCollaborationContribution(result.id, text
        ? { status: 'completed', content: text }
        : { status: 'error', error: result.error ?? 'Contributor returned no visible recommendation' });
    },
  );
}

async function consumeCollaborationRun(
  runTask: Task,
  content: string,
  liveRunId: string,
  collaborationRunId: string,
  active: ActiveCollaboration,
): Promise<void> {
  let finalContext: ContextUsage | null | undefined;
  try {
    let collaboration = getCollaborationRun(collaborationRunId);
    if (!collaboration) throw new Error('Collaboration run was not persisted');
    let taskContext = '';
    try {
      taskContext = collaborationTaskContext(await adapter.getMessages(runTask.id, runTask.id));
    } catch {
      // A brand-new task may not have a Hermes session yet. Collaboration can
      // still proceed from the current question without inventing other context.
    }

    await collectCollaborationPhase(runTask, collaboration, 'proposal', active, taskContext);
    if (active.cancelled) return;
    collaboration = getCollaborationRun(collaborationRunId);
    if (!collaboration) throw new Error('Collaboration run disappeared');

    const participantCount = new Set(
      collaboration.contributions
        .filter((contribution) => contribution.phase === 'proposal')
        .map((contribution) => contribution.profile_id),
    ).size;
    if (participantCount >= 2) {
      collaboration = startCollaborationPhase(collaborationRunId, 'review');
      if (!collaboration) throw new Error('Could not start collaboration review phase');
      active.phase = 'review';
      await collectCollaborationPhase(runTask, collaboration, 'review', active, taskContext);
      if (active.cancelled) return;
    }

    collaboration = getCollaborationRun(collaborationRunId);
    if (!collaboration) throw new Error('Collaboration run disappeared');
    updateCollaborationRun(collaborationRunId, 'synthesizing', { contributorsCompleted: true });
    active.phase = 'synthesizing';
    const supplemental = chairCollaborationContext(collaboration.contributions
      .filter((contribution) => contribution.status === 'completed' || contribution.status === 'error')
      .map((contribution) => ({
        profileId: contribution.profile_id,
        label: contribution.profile_label,
        phase: contribution.phase,
        content: contribution.content,
        error: contribution.error,
      })));

    const chair = await streamChatTurn(runTask, runTask.id, content, {
      completeOnDone: true,
      supplementalSystemMessage: supplemental,
      hideInternalEvents: true,
    });
    if (chair.context !== undefined) finalContext = chair.context;
    if (active.cancelled || chair.interrupted || getRunStatus(runTask.id)?.status === 'stopped') {
      cancelCollaborationRun(collaborationRunId);
      return;
    }
    const persisted = getCollaborationRun(collaborationRunId);
    const contributorErrors = persisted?.contributions.some((result) => result.status === 'error') ?? false;
    updateCollaborationRun(
      collaborationRunId,
      chair.hadError || !chair.sawDone ? 'failed' : contributorErrors ? 'completed_with_errors' : 'completed',
      { completed: true },
    );
  } catch (error) {
    if (!active.cancelled) {
      const message = toErrorMessage(error, 'Collaboration run failed');
      updateCollaborationRun(collaborationRunId, 'failed', { completed: true });
      if (getRunStatus(runTask.id)?.status === 'streaming') {
        const event: StreamEvent = { type: 'error', error: message };
        applyEvent(runTask.id, event);
        broadcastLive(runTask.id, event);
      }
    }
  } finally {
    if (activeCollaborations.get(runTask.id) === active) activeCollaborations.delete(runTask.id);
    if (!active.settled) {
      try {
        settleRun(runTask.id, liveRunId, finalContext ?? null);
      } catch {
        finishRun(runTask.id, ERROR_SNAPSHOT_TTL_MS, liveRunId);
      }
      active.settled = true;
    }
  }
}

async function consumeGoalRun(runTask: Task, sessionId: string, initialContent: string, runId: string): Promise<void> {
  let finalContext: ContextUsage | null | undefined;
  let hadError = false;
  let wasInterrupted = false;
  let turnContent: string | null = initialContent;
  let turnAlreadyVisible = false;
  let turnCount = 0;

  try {
    while (turnContent) {
      if (++turnCount > OLYMPUS_GOAL_MAX_TURNS) {
        appendSystemMessage(runTask.id, 'Goal turn limit reached');
        break;
      }
      if (!turnAlreadyVisible) {
        appendUserMessage(runTask.id, turnContent);
        startAssistantMessage(runTask.id);
      }
      turnAlreadyVisible = false;

      const turn = await streamChatTurn(runTask, sessionId, turnContent, {
        completeOnDone: false,
        captureResponseText: true,
      });
      if (turn.context !== undefined) finalContext = turn.context;
      const currentRun = getRunStatus(runTask.id);
      if (turn.hadError || currentRun?.status === 'error') {
        hadError = true;
        break;
      }
      if (turn.interrupted) {
        wasInterrupted = true;
        break;
      }
      if (turn.pendingSteer) {
        turnContent = turn.pendingSteer;
        turnAlreadyVisible = true;
        continue;
      }

      const decision = await adapter.evaluateGoal(sessionId, turn.responseText);
      let shouldBroadcastSnapshot = false;
      if (decision.state) {
        const goalRun = updateRunGoal(runTask.id, decision.state);
        if (goalRun) broadcast({ type: 'task_run_updated', run: goalRun });
        shouldBroadcastSnapshot = true;
      }
      if (decision.message) {
        appendSystemMessage(runTask.id, decision.message);
        shouldBroadcastSnapshot = true;
      }
      if (shouldBroadcastSnapshot) broadcastRunSnapshot(runTask.id);

      if (!decision.shouldContinue) break;

      turnContent = decision.continuationPrompt?.trim() ? decision.continuationPrompt : null;
    }
  } catch (error) {
    hadError = true;
    const event: StreamEvent = { type: 'error', error: toErrorMessage(error, 'Hermes goal loop failed') };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
  } finally {
    if (!hadError && getRunStatus(runTask.id)?.status === 'streaming') {
      updateRunStatus(runTask.id, wasInterrupted ? 'stopped' : 'done', { context: finalContext ?? null });
    }
    // Goal-turn `done` events are swallowed (completeOnDone=false), so the live
    // channel never sees the terminal status — push a final snapshot for it. The
    // error path already delivered a terminal `error` event, so skip it there.
    if (!hadError) broadcastRunSnapshot(runTask.id);
    settleRun(runTask.id, runId, finalContext ?? null);
  }
}

function beginGoalRunOperation(
  runTask: Task,
  sessionId: string,
  content: string,
): {
  setup: Promise<ReturnType<typeof startGoalRun>>;
  work: Promise<void>;
} {
  let resolveSetup!: (started: ReturnType<typeof startGoalRun>) => void;
  let rejectSetup!: (error: unknown) => void;
  const setup = new Promise<ReturnType<typeof startGoalRun>>((resolve, reject) => {
    resolveSetup = resolve;
    rejectSetup = reject;
  });
  const work = (async () => {
    try {
      const goalState = await adapter.setGoal(sessionId, content);
      const started = startGoalRun(runTask.id, sessionId, goalState);
      createTaskAgentRun({
        runId: started.snapshot.runId,
        taskId: runTask.id,
        kind: started.snapshot.kind,
        status: started.snapshot.status,
        startedAt: started.snapshot.startedAt,
      });
      broadcast({ type: 'task_run_updated', run: started.state });
      broadcastLive(runTask.id, { type: 'snapshot', run: started.snapshot });
      resolveSetup(started);
      await consumeGoalRun(runTask, sessionId, content, started.snapshot.runId);
    } catch (error) {
      rejectSetup(error);
      throw error;
    }
  })();
  return { setup, work };
}

chatRouter.get('/:id/queued-message', (req, res) => {
  const task = res.locals.task as Task;
  res.json({ queuedMessage: getQueuedTaskMessage(task.id) ?? null });
});

chatRouter.put('/:id/queued-message', (req, res) => {
  const task = res.locals.task as Task;
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const rawInvites = req.body?.invitedProfileIds;
  if (!id || !content) return res.status(400).json({ error: 'id and content are required' });
  if (!Array.isArray(rawInvites)) {
    return res.status(400).json({ error: 'invitedProfileIds must contain at most 9 profile IDs' });
  }

  let settings: QueuedTaskMessage['settings'];
  let invitedProfileIds: string[];
  let collaborationScope: CollaborationInvitationScope;
  try {
    const parsed = parseRunSettingsBody({ settings: req.body?.settings });
    const mode = parseChatRunMode({ settings: req.body?.settings });
    const ownerProfileId = task.profile_name ?? DEFAULT_PROFILE_NAME;
    const invites = validateCollaborationInvites(rawInvites, ownerProfileId);
    invitedProfileIds = [
      ...invites.participants.map((profile) => profile.id),
      ...(invites.ownerInvited ? [ownerProfileId] : []),
    ];
    collaborationScope = parseCollaborationInvitationScope(
      req.body?.collaborationScope,
      req.body?.confirmPersistentCollaboration === true,
    );
    if (collaborationScope === 'project') {
      if (!task.project_id) throw new LocalProfileError(400, 'Project collaboration requires a Project task', 'PROJECT_REQUIRED');
      requireProfileProjectAccess(task.project_id, requestProfile(req).id, 'manage');
    }
    settings = {
      ...(parsed.taskFields.agent_model !== undefined ? { model: parsed.taskFields.agent_model } : {}),
      ...(parsed.taskFields.agent_provider !== undefined ? { provider: parsed.taskFields.agent_provider } : {}),
      ...(parsed.taskFields.reasoning_effort !== undefined ? { reasoningEffort: parsed.taskFields.reasoning_effort } : {}),
      mode,
    };
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof LocalProfileError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(400).json({ error: toErrorMessage(error, 'Invalid queued message') });
  }

  const existing = getQueuedTaskMessage(task.id);
  const now = Date.now();
  const queuedMessage: QueuedTaskMessage = {
    id,
    taskId: task.id,
    content,
    settings,
    invitedProfileIds,
    collaborationScope,
    confirmPersistentCollaboration: req.body?.confirmPersistentCollaboration === true,
    createdAt: existing && existing.id === id ? existing.createdAt : now,
    updatedAt: now,
  };
  const saved = putQueuedTaskMessage(queuedMessage);
  if (task.project_id) {
    void syncMessageAttachmentsToProjectReferences(task.project_id, content);
  }
  res.json({ queuedMessage: saved });
});

chatRouter.delete('/:id/queued-message/:queuedMessageId', (req, res) => {
  const task = res.locals.task as Task;
  if (!deleteQueuedTaskMessage(task.id, req.params.queuedMessageId)) {
    return res.status(409).json({ error: 'Queued message changed or no longer exists' });
  }
  res.status(204).end();
});

chatRouter.post('/:id/messages', async (req, res) => {
  const task = res.locals.task as Task;

  const requestBody = isRecord(req.body) ? req.body : {};
  const requestContent = requestBody.content;
  if (!requestContent || typeof requestContent !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }
  let content = requestContent;

  const activeRun = getRunStatus(task.id);
  if (isTaskRunActive(activeRun)) {
    const preclaimed = res.locals.claimedQueuedTaskMessage as QueuedTaskMessage | undefined;
    if (preclaimed) restoreQueuedTaskMessage(preclaimed);
    delete res.locals.claimedQueuedTaskMessage;
    return res.status(409).json({ error: 'This task already has a message in progress' });
  }

  const queuedMessageId = requestBody.queuedMessageId;
  let consumedQueue = res.locals.claimedQueuedTaskMessage as QueuedTaskMessage | undefined;
  delete res.locals.claimedQueuedTaskMessage;
  const restoreConsumedQueue = () => {
    if (!consumedQueue) return;
    restoreQueuedTaskMessage(consumedQueue);
    consumedQueue = undefined;
  };
  if (queuedMessageId !== undefined) {
    if (typeof queuedMessageId !== 'string' || !queuedMessageId.trim()) {
      restoreConsumedQueue();
      return res.status(400).json({ error: 'queuedMessageId must be a non-empty string' });
    }
    consumedQueue ??= consumeQueuedTaskMessage(task.id, queuedMessageId);
    if (!consumedQueue || consumedQueue.id !== queuedMessageId || consumedQueue.content !== content) {
      restoreConsumedQueue();
      return res.status(409).json({ error: 'Queued message changed or no longer exists' });
    }
  } else if (consumedQueue) {
    restoreConsumedQueue();
    return res.status(409).json({ error: 'Queued message changed or no longer exists' });
  }

  const queuedSettings = consumedQueue
    && activeRun?.kind === 'goal'
    && activeRun.goal?.status === 'done'
    && consumedQueue.settings.mode === 'goal'
    ? { ...consumedQueue.settings, mode: 'task' as const }
    : consumedQueue?.settings;
  const effectiveBody = consumedQueue ? {
    ...requestBody,
    content: consumedQueue.content,
    settings: queuedSettings,
    invitedProfileIds: consumedQueue.invitedProfileIds,
    collaborationScope: consumedQueue.collaborationScope,
    confirmPersistentCollaboration: consumedQueue.confirmPersistentCollaboration,
  } : requestBody;
  content = consumedQueue?.content ?? requestContent;
  if (task.project_id) {
    void syncMessageAttachmentsToProjectReferences(task.project_id, content);
  }

  let runSettings: ReturnType<typeof parseRunSettingsBody>;
  let mode: ChatRunMode;
  let invitationScope: CollaborationInvitationScope;
  let collaborationInvites: ReturnType<typeof validateCollaborationInvites>;
  try {
    runSettings = parseRunSettingsBody(effectiveBody);
    mode = parseChatRunMode(effectiveBody);
    invitationScope = parseCollaborationInvitationScope(
      effectiveBody.collaborationScope,
      effectiveBody.confirmPersistentCollaboration === true,
    );
    const ownerProfileId = task.profile_name ?? 'default';
    const requestedInvites = validateCollaborationInvites(effectiveBody.invitedProfileIds, ownerProfileId);
    if (invitationScope === 'project') {
      if (!task.project_id) {
        throw new LocalProfileError(400, 'Project collaboration requires a Project task', 'PROJECT_REQUIRED');
      }
      requireProfileProjectAccess(task.project_id, requestProfile(req).id, 'manage');
    }
    const persistentProfileIds = listPersistentCollaborationGrants({ taskId: task.id, projectId: task.project_id })
      .map((grant) => grant.profileId);
    const effectiveProfileIds = [...new Set([
      ...persistentProfileIds,
      ...requestedInvites.participants.map((profile) => profile.id),
      ...(requestedInvites.ownerInvited ? [ownerProfileId] : []),
    ])];
    collaborationInvites = validateCollaborationInvites(effectiveProfileIds, ownerProfileId);
    if ((collaborationInvites.participants.length > 0 || collaborationInvites.ownerInvited) && mode === 'goal') {
      throw new LocalProfileError(400, 'Collaboration is available in task mode, not goal mode', 'COLLABORATION_GOAL_MODE');
    }
    if (invitationScope !== 'discussion') {
      const scopeId = invitationScope === 'task' ? task.id : task.project_id!;
      const grantedBy = requestProfile(req).id;
      for (const profile of requestedInvites.participants) {
        grantPersistentCollaboration({ scope: invitationScope, scopeId, profileId: profile.id, grantedBy });
      }
    }
  } catch (error) {
    restoreConsumedQueue();
    if (error instanceof ProjectAccessError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error instanceof LocalProfileError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(400).json({ error: toErrorMessage(error, 'Invalid run settings') });
  }

  let runTask = task;
  const taskUpdates: Partial<Pick<Task, 'status' | 'agent_model' | 'agent_provider' | 'reasoning_effort'>> = {};
  if (runSettings.hasFields) {
    const { taskFields } = runSettings;
    if (taskFields.agent_model !== undefined && taskFields.agent_model !== task.agent_model) {
      taskUpdates.agent_model = taskFields.agent_model;
    }
    if (taskFields.agent_provider !== undefined && taskFields.agent_provider !== task.agent_provider) {
      taskUpdates.agent_provider = taskFields.agent_provider;
    }
    if (taskFields.reasoning_effort !== undefined && taskFields.reasoning_effort !== task.reasoning_effort) {
      taskUpdates.reasoning_effort = taskFields.reasoning_effort;
    }
  }
  if (task.status === 'in_review' || task.status === 'done') {
    taskUpdates.status = 'in_progress';
  }

  if (Object.keys(taskUpdates).length > 0) {
    const updated = updateTask(task.id, taskUpdates);
    if (!updated) {
      restoreConsumedQueue();
      return res.status(404).json({ error: 'Task not found' });
    }
    runTask = updated;
    broadcast({ type: 'task_updated', task: updated });
  }

  const sessionId = runTask.id;

  if (mode === 'goal') {
    const releaseRunWork = acquireProfileWork(taskProfileId(runTask));
    let handedOff = false;
    try {
      const operation = beginGoalRunOperation(runTask, sessionId, content);
      releaseProfileWorkWhenSettled(runTask.id, operation.work, releaseRunWork);
      handedOff = true;

      let started: Awaited<typeof operation.setup>;
      try {
        started = await operation.setup;
      } catch (error) {
        restoreConsumedQueue();
        return sendAdapterError(res, error, 'Could not set Hermes goal');
      }

      return res.status(202).json({ runId: started.snapshot.runId });
    } finally {
      if (!handedOff) releaseRunWork();
    }
  }

  const releaseRunWork = acquireProfileWork(taskProfileId(runTask));
  let handedOff = false;
  try {
    const { snapshot, state } = startRun(runTask.id, sessionId, content);
    createTaskAgentRun({
      runId: snapshot.runId,
      taskId: runTask.id,
      kind: snapshot.kind,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
    });
    broadcast({ type: 'task_run_updated', run: state });
    broadcastLive(runTask.id, { type: 'snapshot', run: snapshot });

    const hasCollaboration = collaborationInvites.participants.length > 0 || collaborationInvites.ownerInvited;
    if (hasCollaboration) {
      let collaboration;
      try {
        collaboration = createCollaborationRun({
          taskId: runTask.id,
          question: content,
          ownerProfileId: runTask.profile_name ?? 'default',
          ownerInvited: collaborationInvites.ownerInvited,
          participants: collaborationInvites.participants.map((profile) => ({ id: profile.id, label: profile.label })),
        });
      } catch (error) {
        const message = toErrorMessage(error, 'Could not start collaboration');
        const event: StreamEvent = { type: 'error', error: message };
        applyEvent(runTask.id, event);
        broadcastLive(runTask.id, event);
        settleRun(runTask.id, snapshot.runId, null);
        restoreConsumedQueue();
        return res.status(500).json({ error: message });
      }
      const active: ActiveCollaboration = {
        runId: collaboration.id,
        phase: 'proposal',
        cancelled: false,
        settled: false,
      };
      activeCollaborations.set(runTask.id, active);
      releaseProfileWorkWhenSettled(
        runTask.id,
        consumeCollaborationRun(runTask, content, snapshot.runId, collaboration.id, active),
        releaseRunWork,
      );
      handedOff = true;
      return res.status(202).json({ runId: snapshot.runId, collaborationRunId: collaboration.id });
    }

    releaseProfileWorkWhenSettled(
      runTask.id,
      consumeChatRun(runTask, sessionId, content, snapshot.runId),
      releaseRunWork,
    );
    handedOff = true;
    return res.status(202).json({ runId: snapshot.runId });
  } finally {
    if (!handedOff) releaseRunWork();
  }
});

chatRouter.post('/:id/interrupt', async (req, res) => {
  const task = res.locals.task as Task;

  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim()
    : undefined;
  const collaboration = activeCollaborations.get(task.id);
  if (collaboration && !collaboration.cancelled && collaboration.phase !== 'synthesizing') {
    const live = getRunStatus(task.id);
    const runningContributions = getCollaborationRun(collaboration.runId)?.contributions
      .filter((contribution) => contribution.status === 'running') ?? [];
    collaboration.cancelled = true;
    cancelCollaborationRun(collaboration.runId, reason ?? 'Stopped by user');
    await Promise.allSettled(runningContributions.map((contribution) => (
      adapter.interruptChatForProfile(
        contribution.profile_id,
        contribution.session_id,
        reason ?? 'Stopped by user',
      )
    )));
    activeCollaborations.delete(task.id);
    if (live?.status === 'streaming') {
      updateRunStatus(task.id, 'stopped');
      broadcastRunSnapshot(task.id);
      settleRun(task.id, live.runId, null);
    }
    collaboration.settled = true;
    return res.json({ interrupted: true });
  }

  if (!isInterruptibleRun(getRunStatus(task.id))) {
    return res.status(409).json({ error: 'This task has no active message to stop' });
  }

  if (collaboration && collaboration.phase === 'synthesizing') {
    collaboration.cancelled = true;
    cancelCollaborationRun(collaboration.runId, reason ?? 'Stopped by user');
  }

  try {
    const interrupted = await adapter.interruptChat(task.id, reason);
    if (!interrupted) {
      return res.status(409).json({ error: 'Hermes had no active agent to stop for this task' });
    }
    res.json({ interrupted: true });
  } catch (error) {
    sendAdapterError(res, error, 'Could not stop Hermes run');
  }
});

chatRouter.post('/:id/steer', async (req, res) => {
  const task = res.locals.task as Task;

  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content is required' });
  if (!isInterruptibleRun(getRunStatus(task.id))) {
    return res.status(409).json({ error: 'This task has no active message to steer' });
  }
  // Hermes intentionally queues steers containing files: it cannot safely inject
  // binary attachments into the middle of a running tool turn.
  if (/\n\n\[Attached files:\n[\s\S]*\]$/.test(content)) {
    return res.json({ steered: false, queued: true });
  }

  try {
    const steered = await adapter.steerChat(task.id, content);
    if (steered) {
      appendSteeredUserMessage(task.id, content);
      broadcastRunSnapshot(task.id);
    }
    res.json({ steered, queued: !steered });
  } catch (error) {
    sendAdapterError(res, error, 'Could not steer Hermes run');
  }
});

chatRouter.post('/:id/compact', async (req, res) => {
  const task = res.locals.task as Task;

  const activeRun = getRunStatus(task.id);
  if (isTaskRunActive(activeRun)) {
    return res.status(409).json({
      error: activeRun?.status === 'compacting'
        ? 'This task is already compacting'
        : 'Cannot compact while a message is streaming',
    });
  }

  const focusTopic = typeof req.body?.focusTopic === 'string' ? req.body.focusTopic.trim() || null : null;
  const currentTokens = task.last_context_used_tokens ?? undefined;
  const { snapshot, state } = startCompactionRun(task.id, task.id);
  broadcast({ type: 'task_run_updated', run: state });
  broadcastLive(task.id, { type: 'snapshot', run: snapshot });

  await trackTaskRun(task.id, (async () => {
    try {
      const result: CompactResult = await adapter.compressSession(task.id, {
        focusTopic,
        currentTokens,
        systemMessage: taskSystemMessage(task),
        settings: taskRunSettings(task),
      });

      if (result.context) {
        const updated = recordAgentResponse(task.id, task.last_agent_response_at ?? Date.now(), result.context);
        if (updated) broadcast({ type: 'task_updated', task: updated });
      }

      completeTaskRun(task.id, snapshot.runId, 'done', DONE_SNAPSHOT_TTL_MS, { context: result.context });

      res.json(result);
    } catch (error) {
      const message = toErrorMessage(error, 'Compaction failed');
      completeTaskRun(task.id, snapshot.runId, 'error', ERROR_SNAPSHOT_TTL_MS, { error: message });
      res.status(503).json({ error: message });
    }
  })());
});

chatRouter.get('/:id/live', (req, res) => {
  const task = res.locals.task as Task;

  initSSE(res);
  subscribe(task.id, res);

  const run = getRun(task.id);
  if (run) sendSnapshot(res, run);
});
