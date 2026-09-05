export type RunWatchdogReason = 'idle' | 'runtime';

export interface RunWatchdogOptions {
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  onTimeoutGraceMs?: number;
  onTimeout: (reason: RunWatchdogReason) => Promise<void> | void;
  pauseUntil?: () => number | null | undefined;
  hardDeadlineAtMs?: number;
}

export interface RunWatchdogConfig {
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  finalizeBeforeMs: number;
  childDrainBeforeMs: number;
  maxDelegatedChildren: number;
}

export interface AgentRunBudget extends RunWatchdogConfig {
  hardDeadlineAtMs: number;
}

export class RunWatchdogError extends Error {
  readonly reason: RunWatchdogReason;
  readonly code: 'run_idle_timeout' | 'run_runtime_timeout';
  cause?: unknown;

  constructor(reason: RunWatchdogReason, timeoutMs: number) {
    const label = reason === 'idle' ? 'produced no activity' : 'exceeded its maximum runtime';
    super(`Hermes run ${label} for ${timeoutMs}ms and was stopped`);
    this.name = 'RunWatchdogError';
    this.reason = reason;
    this.code = reason === 'idle' ? 'run_idle_timeout' : 'run_runtime_timeout';
  }
}

async function stopTimedOutRun(reason: RunWatchdogReason, options: RunWatchdogOptions): Promise<never> {
  const watchdogError = new RunWatchdogError(
    reason,
    reason === 'idle' ? options.idleTimeoutMs : options.maxRuntimeMs,
  );
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => options.onTimeout(reason)),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, options.onTimeoutGraceMs ?? 5_000);
      }),
    ]);
  } catch (error) {
    watchdogError.cause = error;
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
  throw watchdogError;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveBelow(value: string | undefined, fallback: number, upperExclusive: number): number {
  const parsed = positiveInteger(value, fallback);
  if (parsed < upperExclusive) return parsed;
  return Math.max(1, Math.floor(upperExclusive / 2));
}

export function runWatchdogConfig(environment: NodeJS.ProcessEnv = process.env): RunWatchdogConfig {
  const maxRuntimeMs = positiveInteger(environment.OLYMPUS_CHAT_MAX_RUN_MS, 60 * 60_000);
  const finalizeBeforeMs = positiveBelow(
    environment.OLYMPUS_CHAT_FINALIZE_BEFORE_MS,
    5 * 60_000,
    maxRuntimeMs,
  );
  return {
    maxRuntimeMs,
    idleTimeoutMs: positiveInteger(environment.OLYMPUS_CHAT_IDLE_TIMEOUT_MS, 5 * 60_000),
    finalizeBeforeMs,
    childDrainBeforeMs: positiveBelow(
      environment.OLYMPUS_CHAT_CHILD_DRAIN_BEFORE_MS,
      2 * 60_000,
      finalizeBeforeMs,
    ),
    maxDelegatedChildren: positiveInteger(environment.OLYMPUS_CHAT_MAX_DELEGATED_CHILDREN, 4),
  };
}

export function createRunBudget(
  config: RunWatchdogConfig = runWatchdogConfig(),
  nowMs = Date.now(),
): AgentRunBudget {
  return { ...config, hardDeadlineAtMs: nowMs + config.maxRuntimeMs };
}

export function remainingRunWatchdogConfig(
  budget: AgentRunBudget,
  nowMs = Date.now(),
): RunWatchdogConfig {
  return {
    ...budget,
    maxRuntimeMs: Math.max(1, budget.hardDeadlineAtMs - nowMs),
  };
}

export async function* withRunWatchdog<T>(
  stream: AsyncIterable<T>,
  options: RunWatchdogOptions,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const startedAt = Date.now();
  let pausedAt: number | null = null;
  let pausedMs = 0;

  try {
    while (true) {
      const now = Date.now();
      const pauseRemaining = Math.max(0, (options.pauseUntil?.() ?? 0) - now);
      if (pauseRemaining > 0 && pausedAt === null) pausedAt = now;
      if (pauseRemaining === 0 && pausedAt !== null) {
        pausedMs += now - pausedAt;
        pausedAt = null;
      }
      const currentPausedMs = pausedMs + (pausedAt === null ? 0 : now - pausedAt);
      const elapsed = now - startedAt - currentPausedMs;
      const hardRemaining = options.hardDeadlineAtMs === undefined ? Infinity : options.hardDeadlineAtMs - now;
      if (elapsed >= options.maxRuntimeMs || hardRemaining <= 0) {
        await stopTimedOutRun('runtime', options);
      }
      const runtimeRemaining = options.maxRuntimeMs - elapsed;
      // Human time is not provider runtime; still stop at the finite input deadline.
      const activeWaitMs = pauseRemaining > 0 ? pauseRemaining : Math.min(options.idleTimeoutMs, runtimeRemaining);
      const waitMs = Math.min(activeWaitMs, hardRemaining);
      const reason: RunWatchdogReason = hardRemaining <= activeWaitMs ? 'runtime' : pauseRemaining > 0 ? 'idle' : runtimeRemaining <= options.idleTimeoutMs ? 'runtime' : 'idle';
      let timer: ReturnType<typeof setTimeout> | undefined;

      type NextOutcome = { kind: 'next'; next: IteratorResult<T> };
      type TimeoutOutcome = { kind: 'timeout'; reason: RunWatchdogReason };
      let outcome: NextOutcome | TimeoutOutcome;
      try {
        outcome = await Promise.race([
          iterator.next().then((next): NextOutcome => ({ kind: 'next', next })),
          new Promise<TimeoutOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout', reason }), waitMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (outcome.kind === 'timeout') {
        await stopTimedOutRun(outcome.reason, options);
        continue;
      }
      if (options.hardDeadlineAtMs !== undefined && Date.now() >= options.hardDeadlineAtMs) {
        await stopTimedOutRun('runtime', options);
      }
      if (outcome.next.done) return;
      const afterNow = Date.now();
      const afterPausedMs = pausedMs + (pausedAt === null ? 0 : afterNow - pausedAt);
      if (afterNow - startedAt - afterPausedMs >= options.maxRuntimeMs) {
        await stopTimedOutRun('runtime', options);
      }
      yield outcome.next.value;
    }
  } finally {
    // Do not await return(): a stalled producer may also stall its cleanup path.
    void iterator.return?.().catch(() => undefined);
  }
}
