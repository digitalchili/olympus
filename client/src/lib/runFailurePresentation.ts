import type { LiveChatRun, LiveChatRunStatus, TaskAgentRun, TaskRunState, TaskStatus } from '@shared/types';

export interface RunFailureNotice {
  status: Extract<LiveChatRunStatus, 'error' | 'stopped'>;
  title: string;
  detail: string;
  code: string | null;
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
    title: 'Run failed before completion',
    detail: `The run failed before completion${code ? ` (${code})` : ''}. The turn is unfinished; review the partial transcript before retrying.`,
  };
}

export function deriveRunFailureNotice(run: RunFailureSource | null | undefined): RunFailureNotice | null {
  if (!run || (run.status !== 'error' && run.status !== 'stopped')) return null;
  const code = cleanCode(run.errorCode) ?? inferCode(run.error);
  return { status: run.status, code, ...runFailureText(run.status, code) };
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
  if (run?.status === 'error' || run?.status === 'stopped') {
    if (run.recoveryState === 'waiting') return 'Waiting to resume';
    return isRecovering(run.recoveryState) ? 'Resuming…' : 'Needs attention';
  }
  if (run?.status === 'done') return 'Needs attention';
  return 'Not running';
}

export function reconcileRunSnapshot(runs: TaskRunState[], current: Map<string, TaskRunState>): Map<string, TaskRunState> {
  return new Map(runs.map(run => {
    const previous = current.get(run.taskId);
    const stale = previous && (previous.startedAt > run.startedAt ||
      (previous.runId === run.runId && ['done', 'error', 'stopped'].includes(previous.status)
        && ['streaming', 'compacting'].includes(run.status)));
    return [run.taskId, stale ? previous : run];
  }));
}
