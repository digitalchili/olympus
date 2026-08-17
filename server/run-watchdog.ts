export type RunWatchdogReason = 'idle' | 'runtime';

export interface RunWatchdogOptions {
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  onTimeoutGraceMs?: number;
  onTimeout: (reason: RunWatchdogReason) => Promise<void> | void;
}

export class RunWatchdogError extends Error {
  readonly reason: RunWatchdogReason;
  cause?: unknown;

  constructor(reason: RunWatchdogReason, timeoutMs: number) {
    const label = reason === 'idle' ? 'produced no activity' : 'exceeded its maximum runtime';
    super(`Hermes run ${label} for ${timeoutMs}ms and was stopped`);
    this.name = 'RunWatchdogError';
    this.reason = reason;
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

export function runWatchdogConfig(environment: NodeJS.ProcessEnv = process.env): Pick<RunWatchdogOptions, 'maxRuntimeMs' | 'idleTimeoutMs'> {
  return {
    maxRuntimeMs: positiveInteger(environment.OLYMPUS_CHAT_MAX_RUN_MS, 30 * 60_000),
    idleTimeoutMs: positiveInteger(environment.OLYMPUS_CHAT_IDLE_TIMEOUT_MS, 5 * 60_000),
  };
}

export async function* withRunWatchdog<T>(
  stream: AsyncIterable<T>,
  options: RunWatchdogOptions,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const startedAt = Date.now();

  try {
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= options.maxRuntimeMs) {
        await stopTimedOutRun('runtime', options);
      }
      const runtimeRemaining = options.maxRuntimeMs - elapsed;
      const waitMs = Math.min(options.idleTimeoutMs, runtimeRemaining);
      const reason: RunWatchdogReason = runtimeRemaining <= options.idleTimeoutMs ? 'runtime' : 'idle';
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
      if (outcome.next.done) return;
      if (Date.now() - startedAt >= options.maxRuntimeMs) {
        await stopTimedOutRun('runtime', options);
      }
      yield outcome.next.value;
    }
  } finally {
    // Do not await return(): a stalled producer may also stall its cleanup path.
    void iterator.return?.().catch(() => undefined);
  }
}
