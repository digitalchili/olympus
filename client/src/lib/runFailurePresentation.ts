import type { LiveChatRun, LiveChatRunStatus, TaskAgentRun, TaskRunState, TaskStatus } from '@shared/types';

export interface RunFailureNotice {
  status: Extract<LiveChatRunStatus, 'error' | 'stopped'>;
  title: string;
  detail: string;
  code: string | null;
  action: 'reconnect_openai' | 'check_openai' | 'provider_settings' | 'usage' | 'model_picker' | 'continue';
}

type RunFailureSource = (TaskAgentRun | LiveChatRun) & {
  error?: string | null;
  errorCode?: string | null;
};

function cleanCode(code: unknown): string | null {
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

function inferCode(error: unknown): string | null {
  if (typeof error !== 'string') return null;
  const bracketed = error.match(/\[([a-z0-9_]+)\]/i)?.[1];
  if (bracketed) return bracketed;
  if (/no activity/i.test(error)) return 'run_idle_timeout';
  if (/maximum runtime|exceeded.*runtime|runtime.*timeout/i.test(error)) return 'run_runtime_timeout';
  if (/iteration/i.test(error)) return 'iteration_limit';
  return null;
}

function runFailureText(status: RunFailureNotice['status'], code: string | null): Pick<RunFailureNotice, 'title' | 'detail'> {
  if (status === 'stopped') {
    return {
      title: 'Needs attention: stopped',
      detail: 'Hermes stopped before completion. The turn is unfinished; review the partial transcript before sending another message.',
    };
  }

  if (code === 'run_runtime_timeout') {
    return {
      title: 'Needs attention: run cap reached',
      detail: 'Hermes hit the run cap before completing this turn. The turn is unfinished; review the partial transcript before retrying.',
    };
  }

  if (code === 'deadline_finalized') {
    return {
      title: 'Needs attention: deadline reached',
      detail: 'The run reached its deadline reserve. Review the available transcript and recovery status; file checkpoint creation has not been verified.',
    };
  }

  if (code === 'run_idle_timeout') {
    return {
      title: 'Needs attention: idle timeout',
      detail: 'Hermes stopped after no activity. The turn is unfinished; review the partial transcript before retrying.',
    };
  }

  if (code === 'iteration_limit') {
    return {
      title: 'Needs attention: iteration limit',
      detail: 'Hermes reached the tool-iteration cap before completing this turn. The turn is unfinished; review the partial transcript before retrying.',
    };
  }

  return {
    title: 'Run ended before completion',
    detail: `The run failed before completion${code ? ` (${code})` : ''}. The turn is unfinished; review the partial transcript before retrying.`,
  };
}

export function deriveRunFailureNotice(run: RunFailureSource | null | undefined): RunFailureNotice | null {
  if (!run || (run.status !== 'error' && run.status !== 'stopped')) return null;
  const code = cleanCode(run.errorCode) ?? inferCode(run.error);
  // Only structured server codes identify the provider; upstream prose is not trusted.
  if (run.status === 'error' && run.errorCode === 'openai_auth_required') return {
    status: run.status, code, action: 'reconnect_openai', title: 'OpenAI sign-in required',
    detail: 'Reconnect OpenAI, then review the saved progress and continue the unfinished task when you are ready.',
  };
  if (run.status === 'error' && run.errorCode === 'openai_auth_unavailable') return {
    status: run.status, code, action: 'check_openai', title: 'OpenAI connection temporarily unavailable',
    detail: 'Check the saved login again. Your task remains unfinished, and signing in again may not be necessary.',
  };
  const categories: Record<string, Pick<RunFailureNotice, 'action' | 'title' | 'detail'>> = {
    auth_error: { action: 'provider_settings', title: 'Provider sign-in or key required', detail: 'Check this profile’s provider settings, then review saved progress before continuing.' },
    rate_limit: { action: 'usage', title: 'Provider rate limit reached', detail: 'View usage and wait for capacity, or choose another model or provider before continuing.' },
    quota_exhausted: { action: 'usage', title: 'Provider allowance unavailable', detail: 'View usage or update this profile’s provider settings before continuing.' },
    model_error: { action: 'model_picker', title: 'Selected model is unavailable', detail: 'Choose an available model, then review saved progress before continuing.' },
  };
  if (run.status === 'error' && run.errorCode && categories[run.errorCode]) return { status: run.status, code, ...categories[run.errorCode] };
  return { status: run.status, code, action: 'continue', ...runFailureText(run.status, code) };
}

export function isOpenAIAuthAction(action: RunFailureNotice['action'] | undefined): boolean {
  return action === 'reconnect_openai' || action === 'check_openai';
}

export function currentLiveRun(liveRun: LiveChatRun | null, latestAgentRun: TaskAgentRun | null): LiveChatRun | null {
  return liveRun && latestAgentRun && (latestAgentRun.startedAt > liveRun.startedAt || (latestAgentRun.runId === liveRun.runId && ['done', 'error', 'stopped'].includes(latestAgentRun.status)))
    ? null
    : liveRun;
}

export function runFailureNoticeForState(input: {
  liveRun: LiveChatRun | null;
  latestAgentRun: TaskAgentRun | null;
}): RunFailureNotice | null {
  const { liveRun, latestAgentRun } = input;
  // History hydration and SSE can arrive out of order across run identities.
  const latest = currentLiveRun(liveRun, latestAgentRun) ?? latestAgentRun;
  return deriveRunFailureNotice(latest);
}

export function shouldAutoSendQueuedMessage(input: {
  queuedMessageId: string | null | undefined;
  taskBusyForQueue: boolean;
  configPending: boolean;
  queuedSendError: string | null;
  loadedTaskId: string | null;
  queueHydratedTaskId: string | null;
  taskId: string;
  pausedByRunFailure: boolean;
}): boolean {
  return Boolean(input.queuedMessageId)
    && !input.taskBusyForQueue
    && !input.configPending
    && !input.queuedSendError
    && !input.pausedByRunFailure
    && input.loadedTaskId === input.taskId
    && input.queueHydratedTaskId === input.taskId;
}

export function canManuallySendQueuedMessage(input: {
  taskBusyForQueue: boolean;
  configPending: boolean;
  queuedIsSending: boolean;
}): boolean {
  return !input.taskBusyForQueue && !input.configPending && !input.queuedIsSending;
}

export function queuedMessageWaitingLabel(input: {
  pausedByRunFailure: boolean;
  compactionBlocker: boolean;
}): string {
  if (input.pausedByRunFailure) return 'Paused after unfinished run';
  return input.compactionBlocker ? 'Sends after compaction' : 'Sends after current response';
}

export function isRecovering(state: string | null | undefined): boolean {
  return state === 'pending' || state === 'waiting' || state === 'dispatching';
}

export function taskExecutionLabel(status: TaskStatus, run?: TaskRunState): string {
  if (status === 'done') return 'Done';
  if (run?.status === 'streaming') return 'Running';
  if (run?.status === 'compacting') return 'Compacting…';
  if (status === 'in_review') return 'In Review';
  if (run?.recoveryWaitReason === 'queued_message') return 'Paused for your queued message';
  if (run?.recoveryWaitReason === 'awaiting_input') return 'Awaiting your answer';
  if (run?.status === 'error' || run?.status === 'stopped') {
    if (run.recoveryState === 'waiting') return 'Waiting to resume';
    return isRecovering(run.recoveryState) ? 'Resuming…' : 'Needs attention';
  }
  if (run?.status === 'done') return isRecovering(run.recoveryState) ? 'Preparing follow-up' : 'Needs attention';
  return 'Not running';
}

export function reconcileRunSnapshot(runs: TaskRunState[], current: Map<string, TaskRunState>): Map<string, TaskRunState> {
  return new Map(runs.map(run => {
    const previous = current.get(run.taskId);
    const stale = previous && (previous.startedAt > run.startedAt ||
      (previous.runId === run.runId && ['done', 'error', 'stopped'].includes(previous.status)
        && ['streaming', 'compacting'].includes(run.status)));
    const merged = previous?.runId === run.runId ? {
      ...run,
      recoveryState: run.recoveryState === undefined ? previous.recoveryState : run.recoveryState,
      recoveryWaitReason: run.recoveryWaitReason === undefined ? previous.recoveryWaitReason : run.recoveryWaitReason,
    } : run;
    return [run.taskId, stale ? previous : merged];
  }));
}
