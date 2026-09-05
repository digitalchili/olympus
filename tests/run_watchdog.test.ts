import assert from 'node:assert/strict';
import {
  RunWatchdogError,
  createRunBudget,
  remainingRunWatchdogConfig,
  runWatchdogConfig,
  withRunWatchdog,
} from '../server/run-watchdog.js';

{
  const config = runWatchdogConfig({});
  assert.equal(config.maxRuntimeMs, 60 * 60_000, 'task runs get a one-hour absolute ceiling');
  assert.equal(config.idleTimeoutMs, 5 * 60_000);
  assert.equal(config.finalizeBeforeMs, 5 * 60_000, 'the last five minutes are reserved for checkpoint/finalization');
  assert.equal(config.childDrainBeforeMs, 2 * 60_000, 'children are drained before the hard deadline');
  assert.equal(config.maxDelegatedChildren, 4, 'one task cannot fan out to ten reviewers');
}

{
  const config = runWatchdogConfig({
    OLYMPUS_CHAT_MAX_RUN_MS: '120000',
    OLYMPUS_CHAT_FINALIZE_BEFORE_MS: '30000',
    OLYMPUS_CHAT_CHILD_DRAIN_BEFORE_MS: '10000',
    OLYMPUS_CHAT_MAX_DELEGATED_CHILDREN: '2',
  });
  assert.deepEqual(config, {
    maxRuntimeMs: 120_000,
    idleTimeoutMs: 5 * 60_000,
    finalizeBeforeMs: 30_000,
    childDrainBeforeMs: 10_000,
    maxDelegatedChildren: 2,
  });
}

{
  const config = runWatchdogConfig({
    OLYMPUS_CHAT_MAX_RUN_MS: '1000',
    OLYMPUS_CHAT_FINALIZE_BEFORE_MS: '1000',
    OLYMPUS_CHAT_CHILD_DRAIN_BEFORE_MS: '2000',
    OLYMPUS_CHAT_MAX_DELEGATED_CHILDREN: '0',
  });
  assert.ok(config.finalizeBeforeMs < config.maxRuntimeMs);
  assert.ok(config.childDrainBeforeMs < config.finalizeBeforeMs);
  assert.equal(config.maxDelegatedChildren, 4);
}

{
  const config = runWatchdogConfig({ OLYMPUS_CHAT_MAX_RUN_MS: '120000' });
  const budget = createRunBudget(config, 1_000);
  assert.equal(budget.hardDeadlineAtMs, 121_000);
  assert.equal(remainingRunWatchdogConfig(budget, 61_000).maxRuntimeMs, 60_000);
  assert.equal(remainingRunWatchdogConfig(budget, 122_000).maxRuntimeMs, 1);
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    activeTimers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    activeTimers.delete(timer);
    originalClearTimeout(timer);
  }) as typeof clearTimeout;

  try {
    async function* rejectsImmediately(): AsyncIterable<string> {
      throw new Error('source stream failed');
    }
    await assert.rejects(
      () => collect(withRunWatchdog(rejectsImmediately(), {
        maxRuntimeMs: 60_000,
        idleTimeoutMs: 60_000,
        onTimeout: async () => undefined,
      })),
      /source stream failed/,
    );
    assert.equal(activeTimers.size, 0, 'a rejected source cannot leak its watchdog timer');
  } finally {
    for (const timer of activeTimers) originalClearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  let interrupted = 0;
  let returned = 0;
  const stalledStream: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => await new Promise<IteratorResult<string>>(() => undefined),
        return: async () => {
          returned += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };

  await assert.rejects(
    () => collect(withRunWatchdog(stalledStream, {
      maxRuntimeMs: 1_000,
      idleTimeoutMs: 20,
      onTimeout: async () => { interrupted += 1; },
    })),
    (error) => error instanceof RunWatchdogError
      && error.reason === 'idle'
      && error.code === 'run_idle_timeout',
  );
  assert.equal(interrupted, 1, 'an idle run is interrupted exactly once');
  assert.equal(returned, 1, 'the stalled source iterator receives best-effort cleanup');
}

{
  let interrupted = 0;
  async function* busyForever(): AsyncIterable<number> {
    let value = 0;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield value++;
    }
  }

  await assert.rejects(
    () => collect(withRunWatchdog(busyForever(), {
      maxRuntimeMs: 35,
      idleTimeoutMs: 50,
      onTimeout: async () => { interrupted += 1; },
    })),
    (error) => error instanceof RunWatchdogError
      && error.reason === 'runtime'
      && error.code === 'run_runtime_timeout',
  );
  assert.equal(interrupted, 1, 'a busy runaway run is interrupted at the wall-clock limit');
}

{
  let interrupted = 0;
  async function* bufferedEvents(): AsyncIterable<number> {
    for (let value = 0; value < 100_000; value += 1) yield value;
  }

  await assert.rejects(
    () => collect(withRunWatchdog(bufferedEvents(), {
      maxRuntimeMs: 1,
      idleTimeoutMs: 1_000,
      onTimeout: async () => { interrupted += 1; },
    })),
    (error) => error instanceof RunWatchdogError && error.reason === 'runtime',
    'continuously ready events cannot starve the wall-clock deadline',
  );
  assert.equal(interrupted, 1);
}

{
  async function* neverSettles(): AsyncIterable<string> {
    await new Promise(() => undefined);
    yield 'unreachable';
  }

  await assert.rejects(
    () => collect(withRunWatchdog(neverSettles(), {
      maxRuntimeMs: 1_000,
      idleTimeoutMs: 20,
      onTimeout: async () => { throw new Error('worker interrupt RPC failed'); },
    })),
    (error) => error instanceof RunWatchdogError && error.reason === 'idle',
    'the run must settle as timed out even when the interrupt RPC fails',
  );
}

{
  const startedAt = Date.now();
  async function* neverSettles(): AsyncIterable<string> {
    await new Promise(() => undefined);
    yield 'unreachable';
  }

  await assert.rejects(
    () => collect(withRunWatchdog(neverSettles(), {
      maxRuntimeMs: 1_000,
      idleTimeoutMs: 20,
      onTimeoutGraceMs: 20,
      onTimeout: async () => { await new Promise(() => undefined); },
    })),
    (error) => error instanceof RunWatchdogError && error.reason === 'idle',
  );
  assert.ok(Date.now() - startedAt < 200, 'a hung interrupt RPC cannot hang watchdog settlement');
}

{
  let interrupted = 0;
  async function* completes(): AsyncIterable<string> {
    yield 'one';
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield 'two';
  }

  assert.deepEqual(await collect(withRunWatchdog(completes(), {
    maxRuntimeMs: 100,
    idleTimeoutMs: 50,
    onTimeout: async () => { interrupted += 1; },
  })), ['one', 'two']);
  assert.equal(interrupted, 0, 'healthy runs are not interrupted');
}

console.log('run watchdog tests passed');
