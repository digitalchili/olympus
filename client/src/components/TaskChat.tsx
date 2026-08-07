import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, Fragment } from 'react';
import { ArrowUp, Loader2, ChevronDown, ChevronRight, Check, Terminal, FileText, FilePenLine, Globe, Code, Wrench, X, Target, Square } from 'lucide-react';
import { InputToolbar, ContextRing } from './InputToolbar';
import { AttachButton, AttachDropOverlay, AttachmentTray, MessageAttachmentCards, UploadErrorBar } from './ChatAttachments';
import { MarkdownContent } from './MarkdownContent';
import { ReplyCopyButton, shouldShowReplyCopyButton } from './ReplyCopyButton';
import { useChat, ToolProgressEvent } from '../hooks/useChat';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { useFileAttachments } from '../hooks/useFileAttachments';
import { handleChatKeyDown, toggleRunMode } from '../lib/keyboard';
import { ApiError, compactTask, fetchHermesProfiles, interruptTask, steerTask, type AgentRunSettings, type HermesProfile } from '../lib/api';
import { deliverQueuedSteer } from '../lib/steerDelivery';
import { useStore } from '../lib/store';
import { GOAL_MODE_PLACEHOLDER, goalTurnLabel, splitAttachmentMessage, toErrorMessage } from '../lib/format';
import { createUuid } from '../lib/uuid';
import { messageTimestampTitle } from '../lib/messageTimestamps';
import {
  addProfileInvite,
  applyProfileMentionSelection,
  findActiveProfileMention,
  numericProfileSelectionIndex,
  removeProfileInvite,
  type ActiveProfileMention,
} from '../lib/profileMentions';
import { ProfileInviteControls } from './ProfileInviteControls';
import { useProfile } from '../contexts/ProfileContext';
import type { ChatRunMode, CollaborationRun, GoalStateSnapshot } from '@shared/types';
import { collaborationAssistantMessageIds } from '../lib/collaborationVisibility';
import { DelegationActivity } from './DelegationActivity';

interface TaskChatProps {
  taskId: string;
  initialMessage?: string;
  initialSettings?: AgentRunSettings;
  initialInvitedProfileIds?: string[];
  collaborationRuns?: CollaborationRun[];
}

type QueuedMessage = {
  id: string;
  content: string;
  settings: AgentRunSettings;
  invitedProfileIds: string[];
};

const ThinkingBlock = memo(function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(isLive);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  if (!content) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{isLive ? 'Thinking…' : 'Thought process'}</span>
        {isLive && <Loader2 size={10} className="animate-spin" />}
      </button>
      {expanded && (
        <div className="mt-2 ml-1 pl-4 py-1 border-l-2 border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400 dark:text-zinc-500 whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-y-auto overflow-x-hidden">
          {content}
        </div>
      )}
    </div>
  );
});

const TOOL_ICONS: Record<string, typeof Terminal> = {
  terminal: Terminal,
  process: Terminal,
  read_file: FileText,
  write_file: FilePenLine,
  patch: FilePenLine,
  execute_code: Code,
  web_search: Globe,
  web_extract: Globe,
  browser_navigate: Globe,
  browser_snapshot: Globe,
  browser_vision: Globe,
};

const INITIAL_RENDER_LIMIT = 12;
const CHAT_COLUMN_CLASS = 'w-full min-w-0 max-w-[760px] mx-auto';
const PLACEHOLDER_CLASS = 'text-sm text-zinc-400 dark:text-zinc-500 text-center py-12';

function ConversationDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-zinc-400 dark:text-zinc-500">
      <div className="h-px min-w-6 flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <span className="min-w-0 text-center leading-relaxed">{children}</span>
      <div className="h-px min-w-6 flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

function getToolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const ToolCallBlock = memo(function ToolCallBlock({ tool }: { tool: ToolProgressEvent }) {
  const Icon = getToolIcon(tool.tool);
  return (
    <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border ${
      tool.status === 'error'
        ? 'border-red-200 dark:border-red-900'
        : 'border-zinc-200 dark:border-zinc-700'
    }`}>
      <Icon size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
      <span className={`text-sm font-medium shrink-0 ${
        tool.status === 'error'
          ? 'text-red-500 dark:text-red-400'
          : 'text-zinc-600 dark:text-zinc-300'
      }`}>
        {formatToolName(tool.tool)}
      </span>
      {tool.label && (
        <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono truncate min-w-0">
          {tool.label}
        </span>
      )}
      {tool.status === 'running' && <Loader2 size={14} className="animate-spin text-zinc-400 shrink-0" />}
      {tool.status === 'completed' && <Check size={14} className="text-zinc-400 shrink-0" />}
      {tool.duration != null && (
        <span className="text-xs text-zinc-300 dark:text-zinc-600 ml-auto shrink-0 tabular-nums">
          {tool.duration.toFixed(1)}s
        </span>
      )}
    </div>
  );
});

function QueuedMessageBar({
  queuedMessage,
  error,
  isSending,
  canRetry,
  waitingLabel,
  canSteer,
  isSteering,
  onSteer,
  onEdit,
  onRemove,
  onRetry,
}: {
  queuedMessage: QueuedMessage;
  error: string | null;
  isSending: boolean;
  canRetry: boolean;
  waitingLabel: string;
  canSteer: boolean;
  isSteering: boolean;
  onSteer: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const statusLabel = isSending ? 'Sending...' : error ?? waitingLabel;
  const { text, filePaths } = splitAttachmentMessage(queuedMessage.content);
  const messagePreview = text || (filePaths.length === 1 ? '1 attachment' : `${filePaths.length} attachments`);

  return (
    <div className="mx-3 mb-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/60 sm:mx-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-md bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              Queued
            </span>
            <span className={`min-w-0 truncate text-xs ${error ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-zinc-700 dark:text-zinc-200">
            {messagePreview}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onSteer}
            disabled={isSending || isSteering || Boolean(error) || !canSteer}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            {isSteering ? 'Steering…' : 'Steer now'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={isSending || isSteering}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          >
            Edit
          </button>
        </div>
        {error && canRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={isSending}
          aria-label="Remove queued message"
          title="Remove queued message"
          className="shrink-0 rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function GoalRunStatus({ goal }: { goal: GoalStateSnapshot | null | undefined }) {
  const turnLabel = goal ? goalTurnLabel(goal.turnsUsed ?? 0, goal.maxTurns ?? 0) : null;

  return (
    <div className={`${CHAT_COLUMN_CLASS} mb-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-100`}>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <Target size={14} strokeWidth={2.5} className="shrink-0" />
        <span className="shrink-0 font-semibold">Goal active</span>
        {turnLabel && (
          <span className="shrink-0 rounded-full border border-zinc-200 bg-white px-2 py-0.5 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {turnLabel}
          </span>
        )}
        <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">
          Hermes will continue if more work remains.
        </span>
      </div>
    </div>
  );
}

export function TaskChat({
  taskId,
  initialMessage,
  initialSettings,
  initialInvitedProfileIds,
  collaborationRuns = [],
}: TaskChatProps) {
  const { activeProfileId } = useProfile();
  const {
    messages,
    isStreaming: liveIsStreaming,
    stopped: runStopped,
    thinkingContent,
    activeTools,
    context,
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    sendMessage,
    loadMessages,
    loadOlderMessages,
  } = useChat();
  const taskRun = useStore((s) => s.taskRuns.get(taskId));
  const delegationRuns = useStore((s) => s.delegationRuns.get(taskId));
  const [input, setInput] = useState('');
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<HermesProfile[]>([]);
  const [activeMention, setActiveMention] = useState<ActiveProfileMention | null>(null);
  const [highlightedProfileIndex, setHighlightedProfileIndex] = useState(0);
  const [runMode, setRunMode] = useState<ChatRunMode>(initialSettings?.mode ?? 'task');
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [messageLoadError, setMessageLoadError] = useState(false);
  const [compactInFlight, setCompactInFlight] = useState(false);
  const [compactDone, setCompactDone] = useState(false);
  const [compactAfterIndex, setCompactAfterIndex] = useState(-1);
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(null);
  const [queuedSendError, setQueuedSendError] = useState<string | null>(null);
  const [autoSendingQueuedId, setAutoSendingQueuedId] = useState<string | null>(null);
  const [steeringQueuedId, setSteeringQueuedId] = useState<string | null>(null);
  const [outgoingRevealActive, setOutgoingRevealActive] = useState(false);
  const [interruptInFlight, setInterruptInFlight] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const {
    pendingFiles,
    dragOver,
    uploadError,
    setUploadError,
    hasUploadingFiles,
    uploadBlocksSend,
    sendBlockedLabel,
    addFiles,
    removeFile,
    retryFile,
    clearFiles,
    submitWithAttachments,
    dragHandlers,
    handlePaste,
  } = useFileAttachments(taskId);
  const startupRef = useRef({ taskId, initialMessage, initialSettings, initialInvitedProfileIds });
  if (startupRef.current.taskId !== taskId) {
    startupRef.current = { taskId, initialMessage, initialSettings, initialInvitedProfileIds };
  }
  const { defaults, modelGroups, model, setModel, provider, setProvider, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig(
    taskId,
    startupRef.current.initialSettings,
  );
  const waitingForTaskSettings = isLoading && !startupRef.current.initialSettings;
  const toolbarDefaults = waitingForTaskSettings ? null : defaults;
  const configPending = waitingForTaskSettings || (!defaults && isLoading);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestUserMessageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const didInitialScrollRef = useRef(false);
  // Long threads are dominated by markdown rendering, so paint the newest messages
  // first and fill in the rest once the user can already read the conversation.
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);
  const pendingAutoSendRef = useRef<string | null>(null);
  const pendingRevealRef = useRef(false);
  const queuedMessageRef = useRef<QueuedMessage | null>(null);
  const lastGoalStatusRef = useRef<GoalStateSnapshot['status'] | null>(null);
  const runIsStreaming = (taskRun?.kind === 'chat' || taskRun?.kind === 'goal') && taskRun.status === 'streaming';
  const isGoalStreaming = taskRun?.kind === 'goal' && taskRun.status === 'streaming';
  const isStreaming = liveIsStreaming || runIsStreaming;
  const isCompacting = taskRun?.kind === 'compact' && taskRun.status === 'compacting';
  const compactionBlocker = isCompacting || compactInFlight;
  const taskBusyForQueue = isStreaming || compactionBlocker;
  const queuedIsSending = autoSendingQueuedId === queuedMessage?.id;
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  }, [messages]);

  const collaborationAssistantIds = useMemo(
    () => collaborationAssistantMessageIds(messages, collaborationRuns),
    [collaborationRuns, messages],
  );

  useEffect(() => {
    let cancelled = false;
    fetchHermesProfiles()
      .then(({ profiles: nextProfiles }) => {
        if (!cancelled) {
          setProfiles(nextProfiles.filter((profile) => profile.active && profile.id !== activeProfileId));
        }
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => { cancelled = true; };
  }, [activeProfileId, taskId]);

  useEffect(() => {
    queuedMessageRef.current = queuedMessage;
  }, [queuedMessage]);

  useEffect(() => {
    const goalStatus = taskRun?.kind === 'goal' ? taskRun.goal?.status ?? null : null;
    const goalCompleted = goalStatus === 'done' || (!goalStatus && lastGoalStatusRef.current === 'done');

    if (goalCompleted) {
      setRunMode('task');
      setQueuedMessage((current) => {
        if (current?.settings.mode !== 'goal') return current;
        return { ...current, settings: { ...current.settings, mode: 'task' } };
      });
    }

    lastGoalStatusRef.current = goalStatus;
  }, [taskRun?.kind, taskRun?.goal?.status]);

  useEffect(() => {
    let cancelled = false;
    setLoadedTaskId(null);
    setMessageLoadError(false);
    setCompactInFlight(false);
    setCompactDone(false);
    setCompactAfterIndex(-1);
    setQueuedMessage(null);
    setSelectedProfiles([]);
    setActiveMention(null);
    setHighlightedProfileIndex(0);
    setQueuedSendError(null);
    setAutoSendingQueuedId(null);
    setRunMode(startupRef.current.initialSettings?.mode ?? 'task');
    setOutgoingRevealActive(false);
    setInterruptInFlight(false);
    setInterruptError(null);
    setUploadError(null);
    clearFiles();
    lastGoalStatusRef.current = null;
    queuedMessageRef.current = null;
    pendingAutoSendRef.current = null;
    pendingRevealRef.current = false;
    didInitialScrollRef.current = false;
    setRenderLimit(INITIAL_RENDER_LIMIT);
    loadMessages(taskId)
      .then((loadedMessages) => {
        if (cancelled) return;
        setLoadedTaskId(taskId);
        const firstMessage = startupRef.current.initialMessage;
        if (firstMessage) {
          const invitedProfileIds = startupRef.current.initialInvitedProfileIds ?? [];
          startupRef.current.initialMessage = undefined;
          startupRef.current.initialInvitedProfileIds = undefined;
          if (loadedMessages.length === 0) {
            pendingRevealRef.current = true;
            setOutgoingRevealActive(true);
            sendMessage(taskId, firstMessage, startupRef.current.initialSettings, { invitedProfileIds });
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        setMessageLoadError(true);
        setLoadedTaskId(taskId);
      });
    return () => { cancelled = true; };
  }, [taskId, loadMessages, sendMessage, clearFiles]);

  useEffect(() => {
    if (!configPending) inputRef.current?.focus();
  }, [configPending, taskId]);

  const updateJumpToBottomVisibility = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    setShowJumpToBottom(container.scrollHeight - container.scrollTop - container.clientHeight > 96);
  }, []);

  const jumpToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, []);

  const handleLoadOlderMessages = useCallback(async () => {
    const container = messagesContainerRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    try {
      await loadOlderMessages(taskId);
      window.requestAnimationFrame(() => {
        const current = messagesContainerRef.current;
        if (current) current.scrollTop = previousTop + current.scrollHeight - previousHeight;
      });
    } catch {
      // The hook exposes a retryable inline error without replacing the loaded page.
    }
  }, [loadOlderMessages, taskId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    updateJumpToBottomVisibility();
    container.addEventListener('scroll', updateJumpToBottomVisibility, { passive: true });
    return () => container.removeEventListener('scroll', updateJumpToBottomVisibility);
  }, [taskId, updateJumpToBottomVisibility]);

  useLayoutEffect(() => {
    updateJumpToBottomVisibility();
  }, [messages.length, isStreaming, updateJumpToBottomVisibility]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || didInitialScrollRef.current) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    didInitialScrollRef.current = true;
  }, [loadedTaskId, messages.length, taskId]);

  // Fill in the deferred older messages once the newest ones are on screen, holding
  // the reading position steady as content is inserted above it.
  useEffect(() => {
    if (loadedTaskId !== taskId || renderLimit >= messages.length) return;

    const handle = window.setTimeout(() => {
      const container = messagesContainerRef.current;
      const previousHeight = container?.scrollHeight ?? 0;
      const previousTop = container?.scrollTop ?? 0;
      setRenderLimit(Number.MAX_SAFE_INTEGER);
      window.requestAnimationFrame(() => {
        const current = messagesContainerRef.current;
        if (current) current.scrollTop = previousTop + current.scrollHeight - previousHeight;
      });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [loadedTaskId, messages.length, renderLimit, taskId]);

  useLayoutEffect(() => {
    if (!compactInFlight && !compactDone) return;
    const container = messagesContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [compactInFlight, compactDone]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || !pendingRevealRef.current) return;

    const container = messagesContainerRef.current;
    const target = latestUserMessageRef.current;
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = container.scrollTop + targetRect.top - containerRect.top - 12;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });

    pendingRevealRef.current = false;
  }, [latestUserMessageId, loadedTaskId, taskId]);

  const sendQueuedMessage = useCallback(async (message: QueuedMessage) => {
    if (pendingAutoSendRef.current) return;

    pendingAutoSendRef.current = message.id;
    pendingRevealRef.current = true;
    setAutoSendingQueuedId(message.id);
    setOutgoingRevealActive(true);
    setQueuedSendError(null);

    const result = await sendMessage(taskId, message.content, message.settings, {
      appendLocalError: false,
      invitedProfileIds: message.invitedProfileIds,
    });
    if (result.ok) {
      setQueuedMessage((current) => current?.id === message.id ? null : current);
    } else if (queuedMessageRef.current?.id === message.id) {
      pendingRevealRef.current = false;
      setOutgoingRevealActive(false);
      setQueuedSendError(result.error);
    }

    if (pendingAutoSendRef.current === message.id) pendingAutoSendRef.current = null;
    setAutoSendingQueuedId((current) => current === message.id ? null : current);
  }, [sendMessage, taskId]);

  useEffect(() => {
    if (!queuedMessage || taskBusyForQueue || configPending || queuedSendError) return;
    void sendQueuedMessage(queuedMessage);
  }, [configPending, queuedMessage, queuedSendError, sendQueuedMessage, taskBusyForQueue]);

  useEffect(() => {
    if (!isStreaming) setInterruptInFlight(false);
  }, [isStreaming]);

  // Safety net: the spinner normally clears when the stream ends, but if that
  // signal never arrives (e.g. the live SSE drops) don't leave it stuck forever.
  useEffect(() => {
    if (!interruptInFlight) return;
    const timer = setTimeout(() => setInterruptInFlight(false), 15_000);
    return () => clearTimeout(timer);
  }, [interruptInFlight]);

  const updateInput = useCallback((nextInput: string, cursor?: number | null) => {
    setInput(nextInput);
    const nextMention = findActiveProfileMention(nextInput, cursor ?? nextInput.length, profiles);
    setActiveMention(nextMention);
    setHighlightedProfileIndex(0);
  }, [profiles]);

  const selectMentionProfile = useCallback((profile: HermesProfile) => {
    if (!activeMention) return;
    const next = applyProfileMentionSelection(input, activeMention, profile);
    setInput(next.text);
    setSelectedProfiles((current) => {
      if (current.some((item) => item.id === profile.id)) return current;
      if (current.length >= 9) {
        setUploadError('You can invite up to 9 profiles.');
        return current;
      }
      return addProfileInvite(current, profile);
    });
    setActiveMention(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }, [activeMention, input]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || configPending || uploadBlocksSend) return;
    if (queuedMessage) return;
    if (runMode === 'goal' && selectedProfiles.length > 0) {
      setUploadError('Remove invited profiles before starting Goal mode. Collaboration runs in Task mode.');
      return;
    }

    const messageText = submitWithAttachments(text);
    const invitedProfileIds = selectedProfiles.map((profile) => profile.id);
    const selectedAtSend = selectedProfiles;
    const settings = { model, provider, reasoningEffort, mode: isGoalStreaming ? 'task' : runMode };
    if (taskBusyForQueue) {
      setQueuedMessage({
        id: createUuid(),
        content: messageText,
        settings,
        invitedProfileIds,
      });
      setQueuedSendError(null);
      setInput('');
      setSelectedProfiles([]);
      setActiveMention(null);
      return;
    }

    setInput('');
    setSelectedProfiles([]);
    setActiveMention(null);
    pendingRevealRef.current = true;
    setOutgoingRevealActive(true);
    const result = await sendMessage(taskId, messageText, settings, { invitedProfileIds });
    if (!result.ok && result.conflict) {
      pendingRevealRef.current = false;
      setOutgoingRevealActive(false);
      // submitWithAttachments already cleared the tray, so restore the full
      // message (incl. attachment paths) rather than just the typed text —
      // otherwise attachments are silently dropped on a busy-task conflict.
      setInput(messageText);
      setSelectedProfiles(selectedAtSend);
    }
  }, [submitWithAttachments, configPending, uploadBlocksSend, input, pendingFiles, queuedMessage, model, provider, reasoningEffort, runMode, isGoalStreaming, taskBusyForQueue, sendMessage, taskId, selectedProfiles, setUploadError]);

  const handleCompact = useCallback(async () => {
    if (compactionBlocker || isStreaming) return;
    setCompactInFlight(true);
    setCompactDone(false);
    try {
      await compactTask(taskId);
      const compactedMessages = await loadMessages(taskId);
      setCompactAfterIndex(compactedMessages.length);
      setCompactDone(true);
    } catch (error) {
      if (queuedMessageRef.current) {
        setQueuedSendError(toErrorMessage(error, 'Compaction failed'));
      }
      throw error;
    } finally {
      setCompactInFlight(false);
    }
  }, [compactionBlocker, isStreaming, loadMessages, taskId]);

  const handleInterrupt = useCallback(async () => {
    if (!isStreaming || interruptInFlight) return;
    setInterruptInFlight(true);
    setInterruptError(null);
    try {
      await interruptTask(taskId);
    } catch (error) {
      // 409 means the run already finished between render and click — nothing to stop, not a failure.
      if (!(error instanceof ApiError && error.status === 409)) {
        setInterruptError(toErrorMessage(error, 'Failed to stop Hermes'));
      }
      setInterruptInFlight(false);
    }
  }, [interruptInFlight, isStreaming, taskId]);

  const handleSteerQueuedMessage = useCallback(async () => {
    if (!queuedMessage || steeringQueuedId || queuedIsSending) return;
    if (queuedMessage.invitedProfileIds.length > 0) return;

    setSteeringQueuedId(queuedMessage.id);
    setQueuedSendError(null);
    try {
      const outcome = await deliverQueuedSteer(
        () => steerTask(taskId, queuedMessage.content),
        () => sendQueuedMessage(queuedMessage),
      );
      if (outcome === 'steered') {
        setQueuedMessage((current) => current?.id === queuedMessage.id ? null : current);
      }
      // When Hermes is between turns or the message has an attachment, it stays
      // queued and the normal post-run send path delivers it without losing data.
    } catch (error) {
      setQueuedSendError(toErrorMessage(error, 'Failed to steer Hermes'));
    } finally {
      setSteeringQueuedId((current) => current === queuedMessage.id ? null : current);
    }
  }, [queuedIsSending, queuedMessage, sendQueuedMessage, steeringQueuedId, taskId]);

  const handleEditQueuedMessage = useCallback(() => {
    if (!queuedMessage || queuedIsSending || steeringQueuedId) return;
    setInput(queuedMessage.content);
    setModel(queuedMessage.settings.model ?? null);
    setProvider(queuedMessage.settings.provider ?? null);
    setReasoningEffort(queuedMessage.settings.reasoningEffort ?? null);
    setRunMode(queuedMessage.settings.mode ?? 'task');
    setSelectedProfiles(profiles.filter((profile) => queuedMessage.invitedProfileIds.includes(profile.id)));
    setActiveMention(null);
    setQueuedMessage(null);
    setQueuedSendError(null);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [profiles, queuedIsSending, queuedMessage, setModel, setProvider, setReasoningEffort, steeringQueuedId]);

  const handleRemoveQueuedMessage = useCallback(() => {
    if (queuedIsSending) return;
    setQueuedMessage(null);
    setQueuedSendError(null);
  }, [queuedIsSending]);

  const handleRetryQueuedMessage = useCallback(() => {
    if (!queuedMessage || taskBusyForQueue || configPending || queuedIsSending) return;
    setQueuedSendError(null);
    void sendQueuedMessage(queuedMessage);
  }, [configPending, queuedIsSending, queuedMessage, sendQueuedMessage, taskBusyForQueue]);

  const goalToggleDisabled = isStreaming || compactionBlocker || queuedMessage !== null;
  const collaborationGoalToggleDisabled = goalToggleDisabled || selectedProfiles.length > 0;
  const handleToggleGoalMode = useCallback(() => {
    if (!collaborationGoalToggleDisabled) setRunMode(toggleRunMode);
  }, [collaborationGoalToggleDisabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (activeMention && activeMention.options.length > 0) {
        const optionCount = Math.min(activeMention.options.length, 9);
        const numericIndex = !e.metaKey && !e.ctrlKey && !e.altKey
          ? numericProfileSelectionIndex(e.key, optionCount)
          : null;
        if (numericIndex !== null) {
          e.preventDefault();
          const profile = activeMention.options[numericIndex] as HermesProfile | undefined;
          if (profile) selectMentionProfile(profile);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedProfileIndex((index) => (index + 1) % optionCount);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedProfileIndex((index) => (index - 1 + optionCount) % optionCount);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const profile = activeMention.options[highlightedProfileIndex] as HermesProfile | undefined;
          if (profile) selectMentionProfile(profile);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setActiveMention(null);
          return;
        }
      }
      handleChatKeyDown(e, handleSubmit, {
        onGoalToggle: handleToggleGoalMode,
        goalToggleDisabled: collaborationGoalToggleDisabled,
      });
    },
    [activeMention, collaborationGoalToggleDisabled, handleSubmit, handleToggleGoalMode, highlightedProfileIndex, selectMentionProfile],
  );
  const isLoadingMessages = loadedTaskId !== taskId;
  const renderOffset = Math.max(0, messages.length - renderLimit);
  const visibleMessages = renderOffset > 0 ? messages.slice(renderOffset) : messages;

  const sendButton = isStreaming
    ? {
        onClick: handleInterrupt,
        disabled: interruptInFlight,
        label: interruptInFlight ? 'Stopping response' : 'Stop response',
        icon: interruptInFlight
          ? <Loader2 size={14} className="animate-spin" />
          : <Square size={11} fill="currentColor" strokeWidth={0} />,
      }
    : {
        onClick: handleSubmit,
        disabled: (!input.trim() && pendingFiles.length === 0) || configPending || queuedMessage !== null || uploadBlocksSend,
        label: sendBlockedLabel ?? 'Send message',
        icon: hasUploadingFiles ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />,
      };

  return (
    <div
      className="relative flex w-full flex-col flex-1 min-h-0"
      {...dragHandlers}
    >
      {dragOver && <AttachDropOverlay />}
      <div className="relative flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className="h-full overflow-y-auto overflow-x-hidden px-3 py-3 sm:px-6 sm:py-4"
        >
          <div className={`${CHAT_COLUMN_CLASS} space-y-3`}>
            {!isLoadingMessages && (hasOlderMessages || olderMessagesError) && (
              <div className="flex flex-col items-center gap-1.5 pb-1">
                <button
                  type="button"
                  onClick={() => void handleLoadOlderMessages()}
                  disabled={isLoadingOlderMessages || !hasOlderMessages}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  {isLoadingOlderMessages && <Loader2 size={12} className="animate-spin" />}
                  {isLoadingOlderMessages ? 'Loading older messages…' : 'Load older messages'}
                </button>
                {olderMessagesError && (
                  <p className="text-xs text-red-500 dark:text-red-400">{olderMessagesError}</p>
                )}
              </div>
            )}
            {isLoadingMessages ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-400 dark:text-zinc-500">
                <Loader2 size={16} className="animate-spin" />
                <span>Loading conversation...</span>
              </div>
            ) : messageLoadError ? (
              <p className={PLACEHOLDER_CLASS}>Unable to load conversation.</p>
            ) : messages.length === 0 ? (
              <p className={PLACEHOLDER_CLASS}>Start a conversation with your assistant.</p>
            ) : null}
            {visibleMessages.map((msg, visibleIdx) => {
              // Keep every index below meaning "position in the full thread" so the
              // deferred first paint stays invisible to the rest of this component.
              const idx = visibleIdx + renderOffset;
              const compactDivider = compactDone && idx === compactAfterIndex ? (
                <ConversationDivider>Conversation compacted</ConversationDivider>
              ) : null;

              if (msg.role === 'system') {
                return (
                  <Fragment key={msg.id}>
                    {compactDivider}
                    <ConversationDivider>{msg.content}</ConversationDivider>
                  </Fragment>
                );
              }

              if (msg.role === 'user') {
                const isLatestUserMessage = msg.id === latestUserMessageId;
                const { text, filePaths } = splitAttachmentMessage(msg.content);
                const timestampLabel = messageTimestampTitle(msg);
                return (
                  <Fragment key={msg.id}>
                    {compactDivider}
                    <div
                      ref={isLatestUserMessage ? latestUserMessageRef : undefined}
                      className="flex min-w-0 justify-end"
                    >
                      <div className="group/message w-full min-w-0 max-w-[92%] sm:max-w-[85%]">
                        <div
                          tabIndex={0}
                          className="ml-auto w-fit min-w-0 max-w-full overflow-hidden rounded-2xl bg-zinc-100 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-900 whitespace-pre-wrap break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:bg-zinc-800 dark:text-zinc-100 sm:px-4"
                        >
                          {text && <div>{text}</div>}
                          <MessageAttachmentCards paths={filePaths} />
                        </div>
                        <div className="mt-1 flex min-h-6 items-center justify-end gap-2">
                          {timestampLabel && (
                            <span
                              data-message-timestamp="message-action-row"
                              className="pointer-events-none whitespace-nowrap text-[11px] leading-none text-zinc-400 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 dark:text-zinc-500"
                            >
                              {timestampLabel}
                            </span>
                          )}
                          {text && <ReplyCopyButton content={text} kind="question" />}
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              }

              const isLastAssistant = idx === messages.length - 1 && msg.role === 'assistant';
              const hideCollaborationInternals = collaborationAssistantIds.has(msg.id);
              const thinkingToShow = hideCollaborationInternals
                ? ''
                : isLastAssistant && isStreaming ? thinkingContent : (msg.thinking || '');
              const isLiveThinking = !hideCollaborationInternals && isLastAssistant && isStreaming && !!thinkingContent;
              const toolsToShow = hideCollaborationInternals
                ? []
                : isLastAssistant && isStreaming ? activeTools : (msg.tools ?? []);
              const showSpinner = isLastAssistant && isStreaming && !msg.content && !thinkingContent && !activeTools.some(t => t.status === 'running');
              const { text: assistantText } = splitAttachmentMessage(msg.content);
              const timestampLabel = messageTimestampTitle(msg);

              return (
                <Fragment key={msg.id}>
                  {compactDivider}
                  <div
                    tabIndex={0}
                    className="group/message flex min-w-0 justify-start rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                  >
                    <div className="min-w-0 w-full sm:px-2">
                      {thinkingToShow && (
                        <ThinkingBlock content={thinkingToShow} isLive={isLiveThinking} />
                      )}
                      {toolsToShow.length > 0 && (
                        <div className="mb-4 space-y-2.5">
                          {toolsToShow.map((tool, i) => (
                            <ToolCallBlock key={`${tool.tool}-${i}`} tool={tool} />
                          ))}
                        </div>
                      )}
                      <div className="min-w-0 max-w-full overflow-hidden text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                        {assistantText ? (
                          <MarkdownContent content={assistantText} isStreaming={isLastAssistant && isStreaming} />
                        ) : (
                          showSpinner && (
                            <span className="inline-flex items-center gap-2 text-zinc-400 dark:text-zinc-500">
                              <span>Thinking</span>
                              <span className="inline-flex gap-1">
                                {[0, 150, 300].map((delay) => (
                                  <span
                                    key={delay}
                                    className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
                                    style={{ animationDelay: `${delay}ms` }}
                                  />
                                ))}
                              </span>
                            </span>
                          )
                        )}
                        <MessageAttachmentCards taskId={taskId} attachments={msg.attachments ?? []} />
                      </div>
                      <div className="mt-1 flex min-h-6 items-center gap-2">
                        {shouldShowReplyCopyButton(assistantText, isLastAssistant && isStreaming) && (
                          <ReplyCopyButton content={assistantText} />
                        )}
                        {timestampLabel && (
                          <span
                            data-message-timestamp="message-action-row"
                            className="pointer-events-none whitespace-nowrap text-[11px] leading-none text-zinc-400 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 dark:text-zinc-500"
                          >
                            {timestampLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
            <DelegationActivity runs={delegationRuns ?? []} />
            {runStopped && <ConversationDivider>Stopped by you</ConversationDivider>}
            {compactInFlight && (
              <ConversationDivider>
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={10} className="shrink-0 animate-spin" />
                  Compacting conversation…
                </span>
              </ConversationDivider>
            )}
            {compactDone && compactAfterIndex >= messages.length && (
              <ConversationDivider>Conversation compacted</ConversationDivider>
            )}
            {outgoingRevealActive && <div aria-hidden="true" className="h-[45vh] sm:h-[52vh]" />}
          </div>
        </div>
        {showJumpToBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="Jump to latest message"
            title="Jump to latest message"
            className="absolute right-5 bottom-4 z-10 rounded-full border border-zinc-200/90 bg-white/90 p-2 text-zinc-500 shadow-sm backdrop-blur transition hover:bg-white hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700/90 dark:bg-zinc-800/90 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 sm:right-8"
          >
            <ChevronDown size={18} strokeWidth={2.5} />
          </button>
        )}
      </div>

      <div className="border-t border-zinc-100 px-3 py-3 dark:border-zinc-800 sm:px-6 sm:py-4">
        {isGoalStreaming && <GoalRunStatus goal={taskRun?.goal} />}
        <div className={`${CHAT_COLUMN_CLASS} rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800 sm:rounded-2xl`}>
          <ProfileInviteControls
            selected={selectedProfiles}
            activeMention={null}
            highlightedIndex={highlightedProfileIndex}
            showPicker={false}
            onSelect={selectMentionProfile}
            onRemove={(profileId) => setSelectedProfiles((current) => removeProfileInvite(current, profileId))}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => updateInput(e.target.value, e.target.selectionStart)}
            onClick={(e) => updateInput(input, e.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={configPending}
            placeholder={runMode === 'goal' ? GOAL_MODE_PLACEHOLDER : 'Message your assistant… Type @ to invite profiles'}
            rows={2}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base leading-relaxed text-zinc-900 placeholder-zinc-400 focus:outline-none disabled:opacity-60 dark:text-zinc-100 dark:placeholder-zinc-500 sm:px-5 sm:text-sm"
          />
          <ProfileInviteControls
            selected={selectedProfiles}
            activeMention={activeMention}
            highlightedIndex={highlightedProfileIndex}
            showSelected={false}
            onSelect={selectMentionProfile}
            onRemove={() => {}}
          />
          <AttachmentTray files={pendingFiles} onRemove={removeFile} onRetry={retryFile} />
          {uploadError && <UploadErrorBar error={uploadError} onDismiss={() => setUploadError(null)} />}
          {interruptError && <UploadErrorBar error={interruptError} onDismiss={() => setInterruptError(null)} />}
          {queuedMessage && (
            <QueuedMessageBar
              queuedMessage={queuedMessage}
              error={queuedSendError}
              isSending={queuedIsSending}
              canRetry={!taskBusyForQueue && !configPending && !queuedIsSending}
              waitingLabel={compactionBlocker ? 'Sends after compaction' : 'Sends after current response'}
              canSteer={queuedMessage.invitedProfileIds.length === 0}
              isSteering={steeringQueuedId === queuedMessage.id}
              onSteer={() => void handleSteerQueuedMessage()}
              onEdit={handleEditQueuedMessage}
              onRemove={handleRemoveQueuedMessage}
              onRetry={handleRetryQueuedMessage}
            />
          )}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 sm:gap-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <AttachButton onFiles={addFiles} disabled={configPending} />
              <InputToolbar
                model={model}
                provider={provider}
                reasoningEffort={reasoningEffort}
                runMode={runMode}
                defaults={toolbarDefaults}
                modelGroups={modelGroups}
                disabled={goalToggleDisabled}
                compactMobile
                onModelChange={(nextModel, nextProvider) => {
                  setModel(nextModel);
                  setProvider(nextProvider ?? null);
                }}
                onReasoningEffortChange={setReasoningEffort}
                onRunModeChange={(nextMode) => {
                  if (nextMode === 'goal' && selectedProfiles.length > 0) {
                    setUploadError('Remove invited profiles before starting Goal mode.');
                    return;
                  }
                  setRunMode(nextMode);
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              {context && (
                <ContextRing
                  context={context}
                  onCompact={handleCompact}
                  compacting={compactionBlocker}
                  compactDisabled={isStreaming || configPending || queuedMessage !== null}
                />
              )}
              <button
                type="button"
                onClick={sendButton.onClick}
                disabled={sendButton.disabled}
                title={sendButton.label}
                aria-label={sendButton.label}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {sendButton.icon}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
