import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  AgentModelResolution,
  CollaborationInvitationScope,
  ContextUsage,
  LiveChatMessage,
  LiveChatRun,
  TaskAgentRun,
  TaskMessage,
  TaskMessagePageInfo,
  ToolProgressEvent,
} from '@shared/types';
import { BASE, fetchMessages } from '../lib/api';
import { apiPathWithProfile } from '../lib/profileQuery';
import { toErrorMessage } from '../lib/format';
import { createUuid } from '../lib/uuid';
import type { AgentRunSettings } from '../lib/api';
import { shouldAppendRunErrorToReply } from '@shared/run-errors';
import { currentLiveRun, runFailureNoticeForState, type RunFailureNotice } from '../lib/runFailurePresentation';

export type { ContextUsage, ToolProgressEvent };

export type SendMessageResult =
  | { ok: true; runId?: string }
  | { ok: false; conflict?: boolean; error: string };

interface SendMessageOptions {
  appendLocalError?: boolean;
  queuedMessageId?: string;
  invitedProfileIds?: string[];
  collaborationScope?: CollaborationInvitationScope;
  confirmPersistentCollaboration?: boolean;
}

export type ChatMessage = Omit<TaskMessage, 'task_id'> & {
  task_id?: string;
  tools?: ToolProgressEvent[];
};

type LiveEvent =
  | { type: 'snapshot'; run: LiveChatRun }
  | { type: 'text_delta'; content?: string }
  | { type: 'thinking_delta'; content?: string }
  | {
      type: 'tool_progress';
      tool?: string;
      status?: ToolProgressEvent['status'];
      duration?: number;
      label?: string;
    }
  | { type: 'model_resolution'; modelResolution: AgentModelResolution }
  | { type: 'done'; sessionId?: string; context?: ContextUsage | null; interrupted?: boolean; attachments?: TaskMessage['attachments']; modelResolution?: AgentModelResolution }
  | { type: 'error'; error?: string; code?: string };

function compactSettings(settings?: AgentRunSettings): AgentRunSettings | undefined {
  if (!settings) return undefined;
  const compacted: AgentRunSettings = {};
  if (settings.model != null) compacted.model = settings.model;
  if (settings.provider != null) compacted.provider = settings.provider;
  if (settings.reasoningEffort != null) compacted.reasoningEffort = settings.reasoningEffort;
  if (settings.mode != null) compacted.mode = settings.mode;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function findLastAssistant(messages: LiveChatMessage[]): LiveChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
}

function ensureAssistant(run: LiveChatRun): LiveChatMessage {
  const existing = findLastAssistant(run.messages);
  if (existing) return existing;
  const msg: LiveChatMessage = {
    id: createUuid(),
    task_id: run.taskId,
    role: 'assistant',
    content: '',
    created_at: Date.now(),
  };
  run.messages.push(msg);
  return msg;
}

export function applyLiveErrorEvent(
  run: LiveChatRun,
  event: Extract<LiveEvent, { type: 'error' }>,
  now = Date.now(),
): void {
  const error = event.error || 'Unknown error';
  run.status = 'error';
  run.error = error;
  (run as LiveChatRun & { errorCode?: string | null }).errorCode = event.code ?? null;
  const assistant = ensureAssistant(run);
  if (shouldAppendRunErrorToReply(event.code) && !assistant.content.includes(`[Error: ${error}]`)) {
    assistant.content = assistant.content
      ? `${assistant.content}\n[Error: ${error}]`
      : `[Error: ${error}]`;
  }
  run.updatedAt = now;
}

function mergeToolProgress(tools: ToolProgressEvent[], event: Extract<LiveEvent, { type: 'tool_progress' }>) {
  const tool: ToolProgressEvent = {
    tool: event.tool ?? 'tool',
    status: event.status ?? 'running',
    duration: event.duration,
    label: event.label,
  };

  if (tool.status === 'running') return [...tools, tool];

  const next = [...tools];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].tool === tool.tool && next[i].status === 'running') {
      next[i] = {
        ...next[i],
        ...tool,
        label: tool.label ?? next[i].label,
      };
      return next;
    }
  }

  return [...next, tool];
}

function snapshotMessages(messages: LiveChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    tools: msg.tools ? msg.tools.map((t) => ({ ...t })) : undefined,
    attachments: msg.attachments ? msg.attachments.map((attachment) => ({ ...attachment })) : undefined,
  }));
}

const OPTIMISTIC_CHAT_ID_PREFIX = 'optimistic-chat-';

function isOptimisticChatMessage(message: LiveChatMessage): boolean {
  return message.id.startsWith(OPTIMISTIC_CHAT_ID_PREFIX);
}

function hasOptimisticChatMessages(run: LiveChatRun): boolean {
  return run.messages.some(isOptimisticChatMessage);
}

export function createOptimisticChatRun(
  taskId: string,
  content: string,
  kind: Extract<LiveChatRun['kind'], 'chat' | 'goal'> = 'chat',
  now = Date.now(),
): LiveChatRun {
  return {
    taskId,
    runId: `${OPTIMISTIC_CHAT_ID_PREFIX}${createUuid()}`,
    kind,
    sessionId: taskId,
    status: 'streaming',
    startedAt: now,
    updatedAt: now,
    messages: [
      {
        id: `${OPTIMISTIC_CHAT_ID_PREFIX}${createUuid()}`,
        task_id: taskId,
        role: 'user',
        content,
        created_at: now,
      },
      {
        id: `${OPTIMISTIC_CHAT_ID_PREFIX}${createUuid()}`,
        task_id: taskId,
        role: 'assistant',
        content: '',
        created_at: now,
        tools: [],
      },
    ],
  };
}

export function shouldCreateOptimisticChatRun(current: LiveChatRun | null): boolean {
  return current?.status !== 'streaming';
}

export function rollbackOptimisticChatRun(
  current: LiveChatRun | null,
  optimisticRunId: string | undefined,
): LiveChatRun | null {
  if (!optimisticRunId || !current) return current;
  if (current.runId === optimisticRunId) return null;
  if (!hasOptimisticChatMessages(current)) return current;
  return {
    ...current,
    messages: current.messages.filter((message) => !isOptimisticChatMessage(message)),
  };
}

interface CommitPushVersionResult {
  commitSha?: string;
  branchName?: string;
  commitMessage?: string;
  changedFiles?: string[];
}

export function settleCommitPushChatResult(input: {
  currentTaskId: string | null;
  responseTaskId: string;
  currentLiveRun: LiveChatRun | null;
  optimisticRunId?: string;
  committedMessages: ChatMessage[];
  content: string;
  version: CommitPushVersionResult;
  now?: number;
}): { applied: boolean; liveRun: LiveChatRun | null; committedMessages: ChatMessage[] } {
  if (input.currentTaskId !== input.responseTaskId) {
    return { applied: false, liveRun: input.currentLiveRun, committedMessages: input.committedMessages };
  }
  const now = input.now ?? Date.now();
  const files = input.version.changedFiles?.length ?? 0;
  return {
    applied: true,
    liveRun: rollbackOptimisticChatRun(input.currentLiveRun, input.optimisticRunId),
    committedMessages: [
      ...input.committedMessages,
      { id: createUuid(), task_id: input.responseTaskId, role: 'user', content: input.content, created_at: now },
      {
        id: createUuid(),
        task_id: input.responseTaskId,
        role: 'assistant',
        content: `Committed and pushed \`${input.version.commitSha?.slice(0, 7) ?? 'unknown'}\` to \`${input.version.branchName ?? 'the Project branch'}\` — ${input.version.commitMessage ?? 'checkpoint'} (${files} file${files === 1 ? '' : 's'}).`,
        created_at: now,
      },
    ],
  };
}

export function reconcileOptimisticChatSnapshot(
  existing: LiveChatRun,
  snapshot: LiveChatRun,
): LiveChatRun {
  if (existing.taskId !== snapshot.taskId) return snapshot;

  const optimisticUser = existing.messages.find(
    (message) => message.role === 'user' && isOptimisticChatMessage(message),
  );
  if (!optimisticUser) return snapshot;
  if (snapshot.messages.some(
    (message) => message.role === 'user' && message.content === optimisticUser.content,
  )) {
    return snapshot;
  }

  const optimisticAssistant = existing.messages.find(
    (message) => message.role === 'assistant' && isOptimisticChatMessage(message),
  );
  const messages = [{ ...optimisticUser }];
  if (optimisticAssistant && !snapshot.messages.some((message) => message.role === 'assistant')) {
    messages.push({
      ...optimisticAssistant,
      tools: optimisticAssistant.tools?.map((tool) => ({ ...tool })),
    });
  }

  return { ...snapshot, messages: [...messages, ...snapshot.messages] };
}

function sameRoleAndContent(left?: ChatMessage, right?: ChatMessage): boolean {
  return !!left && !!right && left.role === right.role && left.content === right.content;
}

function committedWithoutLiveRun(committed: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const firstLive = live[0];
  if (!firstLive || firstLive.role !== 'user') return committed;

  const lastCommitted = committed[committed.length - 1];
  const secondLastCommitted = committed[committed.length - 2];
  const lastLive = live[live.length - 1];

  if (
    sameRoleAndContent(secondLastCommitted, firstLive) &&
    lastLive?.role === 'assistant' &&
    sameRoleAndContent(lastCommitted, lastLive)
  ) {
    return committed.slice(0, -2);
  }

  if (sameRoleAndContent(lastCommitted, firstLive)) {
    return committed.slice(0, -1);
  }

  // Goal runs produce multiple user+assistant pairs in committed that overlap with live messages.
  // Scan for the first live user message paired with the last live assistant to find the cut point.
  let finalLiveAssistant: ChatMessage | undefined;
  for (let k = live.length - 1; k >= 0; k--) {
    if (live[k].role === 'assistant' && live[k].content.length > 0) {
      finalLiveAssistant = live[k];
      break;
    }
  }
  if (finalLiveAssistant) {
    for (let i = committed.length - 1; i >= 0; i--) {
      if (!sameRoleAndContent(committed[i], firstLive)) continue;
      for (let j = i + 1; j < committed.length; j++) {
        if (sameRoleAndContent(committed[j], finalLiveAssistant)) {
          return committed.slice(0, i);
        }
      }
    }
  }

  return committed;
}

function messagesWithLiveRun(committed: ChatMessage[], run: LiveChatRun): ChatMessage[] {
  const live = snapshotMessages(run.messages);
  return [...committedWithoutLiveRun(committed, live), ...live];
}

export function prependOlderMessages(current: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const uniqueOlder = older.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  return [...uniqueOlder, ...current];
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [activeTools, setActiveTools] = useState<ToolProgressEvent[]>([]);
  const [context, setContext] = useState<ContextUsage | null>(null);
  const [modelResolution, setModelResolution] = useState<AgentModelResolution | null>(null);
  const [messagePageInfo, setMessagePageInfo] = useState<TaskMessagePageInfo>({ hasOlder: false, olderCursor: null });
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(null);
  const [runFailureNotice, setRunFailureNotice] = useState<RunFailureNotice | null>(null);

  const postAbortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const committedMessagesRef = useRef<ChatMessage[]>([]);
  const liveRunRef = useRef<LiveChatRun | null>(null);
  const liveContextRef = useRef<ContextUsage | null>(null);
  const persistedModelResolutionRef = useRef<AgentModelResolution | null>(null);
  const persistedLatestAgentRunRef = useRef<TaskAgentRun | null>(null);
  const messagePageInfoRef = useRef<TaskMessagePageInfo>({ hasOlder: false, olderCursor: null });
  const olderLoadTaskRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);

  const closeLiveSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    postAbortRef.current?.abort();
    postAbortRef.current = null;
    closeLiveSource();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [closeLiveSource]);

  const publishState = useCallback(() => {
    const committed = committedMessagesRef.current;
    const liveRun = currentLiveRun(liveRunRef.current, persistedLatestAgentRunRef.current);

    if (liveRun) {
      const isMessageRun = liveRun.kind === 'chat' || liveRun.kind === 'goal';
      const merged = isMessageRun ? messagesWithLiveRun(committed, liveRun) : committed;
      const assistant = isMessageRun ? findLastAssistant(liveRun.messages) : undefined;
      const streaming = isMessageRun && liveRun.status === 'streaming';

      setMessages(merged);
      setIsStreaming(streaming);
      setStopped(isMessageRun && liveRun.status === 'stopped');
      setThinkingContent(streaming ? assistant?.thinking ?? '' : '');
      setActiveTools(streaming ? assistant?.tools?.map((t) => ({ ...t })) ?? [] : []);
      setContext(liveRun.context !== undefined ? liveRun.context : liveContextRef.current);
      setModelResolution(liveRun.modelResolution ?? null);
      setRunFailureNotice(runFailureNoticeForState({ liveRun, latestAgentRun: persistedLatestAgentRunRef.current }));
      return;
    }

    setMessages(committed);
    setIsStreaming(false);
    setStopped(false);
    setThinkingContent('');
    setActiveTools([]);
    setContext(liveContextRef.current);
    setModelResolution(persistedModelResolutionRef.current);
    setRunFailureNotice(runFailureNoticeForState({ liveRun: null, latestAgentRun: persistedLatestAgentRunRef.current }));
  }, []);

  const schedulePublish = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      publishState();
    });
  }, [publishState]);

  const applySnapshot = useCallback((run: LiveChatRun) => {
    if (taskIdRef.current && taskIdRef.current !== run.taskId) return;
    taskIdRef.current = run.taskId;
    if (!currentLiveRun(run, persistedLatestAgentRunRef.current)) return;

    const existingLiveRun = currentLiveRun(liveRunRef.current, persistedLatestAgentRunRef.current);
    if (
      existingLiveRun &&
      hasOptimisticChatMessages(existingLiveRun) &&
      existingLiveRun.runId !== run.runId &&
      run.status !== 'streaming' &&
      run.startedAt < existingLiveRun.startedAt
    ) {
      return;
    }

    if (
      existingLiveRun &&
      existingLiveRun.runId !== run.runId &&
      !hasOptimisticChatMessages(existingLiveRun)
    ) {
      committedMessagesRef.current = messagesWithLiveRun(committedMessagesRef.current, existingLiveRun);
    }

    const nextRun = existingLiveRun
      ? reconcileOptimisticChatSnapshot(existingLiveRun, run)
      : run;
    liveRunRef.current = nextRun;
    if (nextRun.context !== undefined) liveContextRef.current = nextRun.context;
    publishState();
  }, [publishState]);

  const applyLiveEvent = useCallback((event: LiveEvent) => {
    if (event.type === 'snapshot') {
      applySnapshot(event.run);
      return;
    }

    const run = currentLiveRun(liveRunRef.current, persistedLatestAgentRunRef.current);
    if (!run) return;

    if (event.type === 'text_delta' && event.content) {
      ensureAssistant(run).content += event.content;
      run.updatedAt = Date.now();
      schedulePublish();
      return;
    }

    if (event.type === 'thinking_delta' && event.content) {
      const assistant = ensureAssistant(run);
      assistant.thinking = (assistant.thinking ?? '') + event.content;
      run.updatedAt = Date.now();
      schedulePublish();
      return;
    }

    if (event.type === 'tool_progress') {
      const assistant = ensureAssistant(run);
      assistant.tools = mergeToolProgress(assistant.tools ?? [], event);
      run.updatedAt = Date.now();
      schedulePublish();
      return;
    }

    if (event.type === 'model_resolution') {
      run.modelResolution = {
        requested: { ...event.modelResolution.requested },
        actual: { ...event.modelResolution.actual },
        fallbackReason: event.modelResolution.fallbackReason ?? null,
      };
      persistedModelResolutionRef.current = run.modelResolution;
      run.updatedAt = Date.now();
      publishState();
      return;
    }

    if (event.type === 'error') {
      applyLiveErrorEvent(run, event);
      publishState();
      return;
    }

    if (event.type === 'done') {
      if (event.modelResolution) {
        run.modelResolution = {
          requested: { ...event.modelResolution.requested },
          actual: { ...event.modelResolution.actual },
          fallbackReason: event.modelResolution.fallbackReason ?? null,
        };
        persistedModelResolutionRef.current = run.modelResolution;
      }
      if (event.attachments) ensureAssistant(run).attachments = event.attachments.map((attachment) => ({ ...attachment }));
      if (event.sessionId) run.sessionId = event.sessionId;
      if (run.status !== 'error') run.status = event.interrupted ? 'stopped' : 'done';
      ensureAssistant(run).completed_at = Date.now();
      if (event.context !== undefined) {
        run.context = event.context;
        liveContextRef.current = event.context;
      }
      run.updatedAt = Date.now();
      publishState();
    }
  }, [applySnapshot, publishState, schedulePublish]);

  const openLiveSubscription = useCallback((taskId: string) => {
    const existing = sourceRef.current;
    if (
      existing &&
      taskIdRef.current === taskId &&
      existing.readyState !== EventSource.CLOSED
    ) {
      return;
    }

    closeLiveSource();
    taskIdRef.current = taskId;

    const source = new EventSource(`${BASE}${apiPathWithProfile(`/tasks/${encodeURIComponent(taskId)}/live`)}`);
    source.onmessage = (message) => {
      if (taskIdRef.current !== taskId) return;
      try {
        applyLiveEvent(JSON.parse(message.data) as LiveEvent);
      } catch (err) {
        console.warn('Failed to parse live chat event:', message.data, err);
      }
    };
    source.onerror = () => {};
    sourceRef.current = source;
  }, [applyLiveEvent, closeLiveSource]);

  const clearAllState = useCallback(() => {
    teardown();
    taskIdRef.current = null;
    committedMessagesRef.current = [];
    liveRunRef.current = null;
    liveContextRef.current = null;
    persistedModelResolutionRef.current = null;
    persistedLatestAgentRunRef.current = null;
    messagePageInfoRef.current = { hasOlder: false, olderCursor: null };
    olderLoadTaskRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setStopped(false);
    setThinkingContent('');
    setActiveTools([]);
    setContext(null);
    setModelResolution(null);
    setRunFailureNotice(null);
    setMessagePageInfo(messagePageInfoRef.current);
    setIsLoadingOlderMessages(false);
    setOlderMessagesError(null);
  }, [teardown]);

  const loadMessages = useCallback(async (taskId: string) => {
    clearAllState();
    taskIdRef.current = taskId;

    const { messages: msgs, pageInfo, context: persistedContext, latestAgentRun } = await fetchMessages(taskId);
    if (taskIdRef.current !== taskId) return msgs;

    committedMessagesRef.current = msgs as ChatMessage[];
    messagePageInfoRef.current = pageInfo;
    liveContextRef.current = persistedContext ?? null;
    persistedModelResolutionRef.current = latestAgentRun?.modelResolution ?? null;
    persistedLatestAgentRunRef.current = latestAgentRun ?? null;
    setMessagePageInfo(pageInfo);
    publishState();
    openLiveSubscription(taskId);
    return msgs;
  }, [clearAllState, openLiveSubscription, publishState]);

  const loadOlderMessages = useCallback(async (taskId: string) => {
    const cursor = messagePageInfoRef.current.olderCursor;
    if (taskIdRef.current !== taskId || !cursor || olderLoadTaskRef.current === taskId) return [];

    olderLoadTaskRef.current = taskId;
    setIsLoadingOlderMessages(true);
    setOlderMessagesError(null);
    try {
      const page = await fetchMessages(taskId, cursor);
      if (taskIdRef.current !== taskId) return page.messages;

      committedMessagesRef.current = prependOlderMessages(
        committedMessagesRef.current,
        page.messages as ChatMessage[],
      );
      messagePageInfoRef.current = page.pageInfo;
      setMessagePageInfo(page.pageInfo);
      publishState();
      return page.messages;
    } catch (error) {
      if (taskIdRef.current === taskId) {
        setOlderMessagesError(toErrorMessage(error, 'Unable to load older messages.'));
      }
      throw error;
    } finally {
      if (olderLoadTaskRef.current === taskId) olderLoadTaskRef.current = null;
      if (taskIdRef.current === taskId) setIsLoadingOlderMessages(false);
    }
  }, [publishState]);

  const finishOptimisticSendError = useCallback((
    taskId: string,
    optimisticRunId: string | undefined,
    content: string,
    error: string,
    appendLocalError: boolean,
  ) => {
    if (taskIdRef.current !== taskId) return;

    liveRunRef.current = rollbackOptimisticChatRun(
      liveRunRef.current,
      optimisticRunId,
    );
    if (appendLocalError) {
      const now = Date.now();
      committedMessagesRef.current = [
        ...committedMessagesRef.current,
        { id: createUuid(), task_id: taskId, role: 'user', content, created_at: now },
        { id: createUuid(), task_id: taskId, role: 'assistant', content: `[Error: ${error}]`, created_at: now },
      ];
    }
    publishState();
  }, [publishState]);

  const sendMessage = useCallback(async (
    taskId: string,
    content: string,
    settings?: AgentRunSettings,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> => {
    openLiveSubscription(taskId);

    const previousRun = liveRunRef.current;
    const optimisticRun = shouldCreateOptimisticChatRun(previousRun)
      ? createOptimisticChatRun(
        taskId,
        content,
        settings?.mode === 'goal' ? 'goal' : 'chat',
      )
      : null;
    if (optimisticRun) {
      if (previousRun) {
        committedMessagesRef.current = messagesWithLiveRun(committedMessagesRef.current, previousRun);
      }
      liveRunRef.current = optimisticRun;
      publishState();
    }

    const abort = new AbortController();
    postAbortRef.current = abort;
    const runSettings = compactSettings(settings);

    try {
      const res = await fetch(`${BASE}${apiPathWithProfile(`/tasks/${encodeURIComponent(taskId)}/messages`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          ...(runSettings ? { settings: runSettings } : {}),
          ...(options?.queuedMessageId ? { queuedMessageId: options.queuedMessageId } : {}),
          ...(options?.invitedProfileIds?.length ? {
            invitedProfileIds: options.invitedProfileIds,
            collaborationScope: options.collaborationScope ?? 'discussion',
            ...(options.confirmPersistentCollaboration ? { confirmPersistentCollaboration: true } : {}),
          } : {}),
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        const error = body.error || `HTTP ${res.status}`;
        finishOptimisticSendError(
          taskId,
          optimisticRun?.runId,
          content,
          error,
          res.status !== 409 && options?.appendLocalError !== false,
        );
        return { ok: false, conflict: res.status === 409, error };
      }
      const body = await res.json().catch(() => ({})) as {
        runId?: string;
        action?: string;
        version?: { commitSha?: string; branchName?: string; commitMessage?: string; changedFiles?: string[] };
      };
      if (body.action === 'commit_push' && body.version) {
        const settled = settleCommitPushChatResult({
          currentTaskId: taskIdRef.current,
          responseTaskId: taskId,
          currentLiveRun: liveRunRef.current,
          optimisticRunId: optimisticRun?.runId,
          committedMessages: committedMessagesRef.current,
          content,
          version: body.version,
        });
        if (settled.applied) {
          liveRunRef.current = settled.liveRun;
          committedMessagesRef.current = settled.committedMessages;
          publishState();
        }
        return { ok: true };
      }
      if (
        body.runId &&
        optimisticRun &&
        taskIdRef.current === taskId &&
        liveRunRef.current?.runId === optimisticRun.runId
      ) {
        liveRunRef.current.runId = body.runId;
      }
      return { ok: true, runId: body.runId };
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const error = toErrorMessage(err, 'Failed to send message.');
        finishOptimisticSendError(
          taskId,
          optimisticRun?.runId,
          content,
          error,
          options?.appendLocalError !== false,
        );
        return { ok: false, error };
      }
      finishOptimisticSendError(taskId, optimisticRun?.runId, content, '', false);
      return { ok: false, error: 'Message send was cancelled.' };
    } finally {
      if (postAbortRef.current === abort) postAbortRef.current = null;
    }
  }, [finishOptimisticSendError, openLiveSubscription, publishState]);

  useEffect(() => () => {
    teardown();
  }, [teardown]);

  return {
    messages,
    isStreaming,
    stopped,
    thinkingContent,
    activeTools,
    context,
    modelResolution,
    runFailureNotice,
    hasOlderMessages: messagePageInfo.hasOlder,
    isLoadingOlderMessages,
    olderMessagesError,
    sendMessage,
    loadMessages,
    loadOlderMessages,
    reset: clearAllState,
  };
}
