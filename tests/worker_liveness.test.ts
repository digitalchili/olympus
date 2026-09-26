import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HermesWorkerClient } from '../server/adapters/hermes-worker.js';

type Internal = {
  child: ChildProcessWithoutNullStreams | null;
  ready: boolean;
  readyPromise: Promise<void> | null;
  pending: Map<string, unknown>;
  ensureStarted(): void;
  sendRequest(request: { type: string; draining?: boolean }): Promise<unknown>;
  handleExit(child: ChildProcessWithoutNullStreams, error: Error): void;
};
function fixture() {
  const client = new HermesWorkerClient('/unused-hermes-home');
  const internal = client as unknown as Internal;
  const kills: unknown[] = [];
  const child = { killed: false, exitCode: null, kill: (signal: unknown) => kills.push(signal) } as unknown as ChildProcessWithoutNullStreams;
  internal.child = child;
  internal.ensureStarted = () => {};
  return { client, internal, child, kills };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// A failed probe observes the same live process; recovery needs no replacement.
{
  const { client, internal, child, kills } = fixture();
  internal.ready = true;
  let failures = 0;
  internal.pending.set('active', { kind: 'stream', fail() { failures++; } });
  client.request = async () => new Promise<never>(() => {});
  const keepAlive = setInterval(() => {}, 100);
  try { assert.equal(await client.healthCheck(15), false); }
  finally { clearInterval(keepAlive); }
  assert.deepEqual(kills, []);
  assert.equal(failures, 0);
  assert.equal(internal.child, child);
  client.request = async () => ({ ok: true }) as never;
  assert.equal(await client.healthCheck(15), true);
  assert.equal(internal.child, child);
}

// Old exit/error callbacks cannot reject requests belonging to a replacement.
{
  const { client, internal, child } = fixture();
  let resets = 0, failures = 0;
  client.onDelegationReset(() => { resets++; });
  internal.pending.set('old', { kind: 'stream', fail(error: Error & { code?: string }) {
    assert.equal(error.code, 'worker_restarted'); failures++;
  } });
  internal.handleExit(child, new Error('exit'));
  assert.equal(failures, 1);
  assert.equal(resets, 1);
  const replacement = fixture().child;
  internal.child = replacement;
  internal.ready = true;
  internal.pending.set('new', { kind: 'stream', fail() { failures++; } });
  internal.handleExit(child, new Error('late duplicate error'));
  assert.equal(internal.child, replacement, 'old child callback must preserve the replacement');
  assert.equal(internal.ready, true);
  assert.equal(internal.pending.has('new'), true);
  assert.equal(failures, 1);
  assert.equal(resets, 1);
  internal.handleExit(replacement, new Error('replacement exit'));
  internal.handleExit(replacement, new Error('duplicate exit'));
  assert.equal(failures, 2);
  assert.equal(resets, 2);
}

// Readiness can settle after a crash/stop; neither its result nor finally owns new state.
for (const phase of ['health', 'drain', 'failure', 'stop'] as const) {
  const { client, internal, child } = fixture();
  const old = deferred<{ ok: boolean; draining?: boolean; activeRuns?: number }>();
  const fresh = deferred<{ ok: boolean }>();
  let healthCalls = 0, drainCalls = 0;
  internal.sendRequest = async (request) => {
    if (request.type === 'health') {
      healthCalls++;
      return healthCalls === 1 ? (phase === 'drain' ? { ok: true } : old.promise) : fresh.promise;
    }
    drainCalls++;
    if (phase === 'drain' && drainCalls === 1) return old.promise;
    return { draining: request.draining, activeRuns: 0 };
  };
  const first = client.start().catch(error => error);
  await flush();
  if (phase === 'stop') {
    Object.assign(child, { exitCode: 0 });
    await client.stop();
  } else internal.handleExit(child, new Error('old exit'));
  const replacement = fixture().child;
  internal.child = replacement;
  const second = client.start();
  const currentPromise = internal.readyPromise;
  if (phase === 'failure') old.reject(new Error('late readiness failure'));
  else old.resolve({ ok: true, draining: false, activeRuns: 0 });
  assert.ok(await first instanceof Error, `${phase}: stale startup must reject`);
  assert.equal(internal.ready, false, `${phase}: stale startup cannot mark the replacement ready`);
  assert.equal(internal.readyPromise, currentPromise, `${phase}: stale finally cannot clear new startup`);
  assert.equal(healthCalls, 2, `${phase}: replacement must perform its own handshake`);
  assert.equal(drainCalls, phase === 'drain' ? 1 : 0, `${phase}: old startup cannot send another drain request`);
  fresh.resolve({ ok: true });
  await second;
  assert.equal(internal.ready, true);
  assert.equal(internal.readyPromise, null);
}

{
  const { client, internal, child } = fixture();
  const old = deferred<{ ok: boolean }>();
  let calls = 0;
  internal.sendRequest = async request => request.type === 'health'
    ? (++calls === 1 ? old.promise : { ok: true })
    : { draining: request.draining, activeRuns: 0 };
  const first = client.start().catch(error => error);
  internal.handleExit(child, new Error('exit before startup reply'));
  internal.child = fixture().child;
  await client.start();
  old.reject(new Error('late failure after replacement is ready'));
  assert.ok(await first instanceof Error);
  assert.equal(internal.ready, true, 'an old catch cannot mark a ready replacement unhealthy');
}
console.log('Worker lifecycle generation tests passed');
