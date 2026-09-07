import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { LiveChatRun, TaskMessagesPage, TaskRunState } from '../shared/types.js';
import type { useChat } from '../client/src/hooks/useChat.js';

// Exercise the real hook callbacks with deterministic hooks, HTTP, SSE and timers.
// React rendering is separate; these tests cover connection and response ordering.
const hookFile = new URL('../client/src/hooks/useChat.ts', import.meta.url);
const requireHookDependency = createRequire(hookFile);
const hookCode = ts.transpileModule(readFileSync(hookFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
const { reconcilePersistedTaskRun, useStore } = await import('../client/src/lib/store.js');

class FakeEventSource {
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (message: { data: string }) => void;
  constructor(public url: string) {}
  open() { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }
  error() { this.readyState = 0; this.onerror?.(); }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

function harness() {
  useStore.getState().setTaskRuns([]);
  const slots: unknown[] = [];
  let cursor = 0;
  const sources: FakeEventSource[] = [];
  const requests: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const fetchedRuns: Array<TaskRunState | null> = [];
  const fetchMock = () => new Promise<Response>((resolve, reject) => requests.push({ resolve, reject }));
  globalThis.fetch = fetchMock;
  const exports = {};
  runInNewContext(hookCode, {
    exports,
    require: (name: string) => name === 'react' ? {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next: unknown) => { slots[index] = next; }];
      },
      useRef: (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useCallback: (callback: unknown) => callback,
      useEffect: () => {},
    } : requireHookDependency(name),
    EventSource: class extends FakeEventSource {
      constructor(url: string) { super(url); sources.push(this); }
    },
    fetch: fetchMock,
    AbortController,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    cancelAnimationFrame: (id: number) => timers.delete(id),
    console,
  });
  const mountedUseChat = (exports as { useChat: typeof useChat }).useChat;
  const render = () => {
    cursor = 0;
    return mountedUseChat((run) => { fetchedRuns.push(run); reconcilePersistedTaskRun(run); });
  };
  const respond = (index: number, body: TaskMessagesPage) => requests[index].resolve(Response.json(body));
  return {
    render, sources, requests, respond, timers, fetchedRuns,
    async load(page = history()) {
      const loaded = render().loadMessages('task-1');
      respond(requests.length - 1, page);
      await loaded;
      return sources.at(-1)!;
    },
    retry() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    },
  };
}

function live(runId = 'run-1', startedAt = 100, status: LiveChatRun['status'] = 'streaming'): LiveChatRun {
  return {
    taskId: 'task-1', runId, kind: 'chat', sessionId: 'task-1', status, startedAt, updatedAt: startedAt,
    messages: [
      { id: `${runId}-user`, task_id: 'task-1', role: 'user', content: 'hi', created_at: startedAt },
      { id: `${runId}-assistant`, task_id: 'task-1', role: 'assistant', content: 'Hello.', created_at: startedAt },
    ],
  };
}

function history(run?: LiveChatRun): TaskMessagesPage {
  return {
    messages: run?.messages ?? [],
    pageInfo: { hasOlder: false, olderCursor: null },
    latestAgentRun: run ? {
      runId: run.runId, taskId: run.taskId, kind: run.kind, status: run.status,
      startedAt: run.startedAt, updatedAt: run.updatedAt, completedAt: run.status === 'streaming' ? null : 200,
      modelResolution: null,
    } : null,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const originalFetch = globalThis.fetch;
try {
  {
    const h = harness();
    const source = await h.load();
    source.open();
    source.emit({ type: 'snapshot', run: live() });
    h.requests[1].reject(new Error('History unavailable'));
    await flush();
    assert.equal(h.render().connectionState, 'connected', 'a history failure must not label an open SSE transport as reconnecting');
    assert.ok(h.render().historyRefreshError, 'history failures have their own retry notice');
    assert.equal(h.render().isStreaming, true);
    assert.equal(h.render().messages.at(-1)?.content, 'Hello.');
    useStore.getState().setTaskRun(live());
    source.emit({ type: 'snapshot', run: live('run-1', 100, 'done') });
    assert.equal(h.render().isStreaming, false, 'a terminal snapshot settles streaming even while history is unavailable');
    assert.equal(useStore.getState().taskRuns.has('task-1'), false, 'the terminal live snapshot also clears a stale busy run in the board store');
    assert.equal(h.render().messages.at(-1)?.content, 'Hello.', 'the completed live answer survives a failed history refresh');
    h.retry();
    h.respond(2, history(live('run-1', 100, 'done')));
    await flush();
    assert.equal(h.render().historyRefreshError, null);
    h.render().reset();
  }
  for (const status of ['error', 'stopped'] as const) {
    const h = harness();
    const source = await h.load();
    source.open();
    source.emit({ type: 'snapshot', run: live() });
    useStore.getState().setTaskRun(live());
    h.requests[1].reject(new Error('History unavailable'));
    await flush();
    source.emit({ type: 'snapshot', run: live('run-1', 100, status) });
    assert.equal(h.render().isStreaming, false);
    assert.equal(useStore.getState().taskRuns.has('task-1'), false, `${status} snapshots retire the stale busy state while history is unavailable`);
    assert.equal(h.render().runFailureNotice?.status, status, 'terminal recovery preserves the unfinished-run notice');
    assert.equal(h.render().messages.at(-1)?.content, 'Hello.');
    h.render().reset();
  }
  {
    const h = harness();
    const source = await h.load();
    source.open();
    source.emit({ type: 'snapshot', run: live() });
    h.respond(1, history(live()));
    await flush();
    source.error();
    assert.equal(h.render().connectionState, 'reconnecting');
    source.open();
    assert.equal(h.render().connectionState, 'connected', 'SSE reopening clears reconnecting before slow history returns');
    h.respond(2, history(live('run-1', 100, 'done')));
    await flush();
    assert.equal(h.render().isStreaming, false, 'durable terminal history settles a missed terminal event when the snapshot has expired');
    assert.equal(h.fetchedRuns.at(-1)?.status, 'done', 'durable terminal state also reconciles the board run store');
    assert.equal(h.render().messages.at(-1)?.content, 'Hello.');
    h.render().reset();
  }
  {
    const h = harness();
    const source = await h.load();
    source.open();
    source.error();
    h.respond(1, history());
    await flush();
    assert.equal(h.render().connectionState, 'reconnecting', 'late history success cannot claim a disconnected SSE transport is healthy');
    source.open();
    const requestBeforeAnotherReconnect = 2;
    source.error();
    source.open();
    h.respond(3, history(live('run-2', 300, 'done')));
    await flush();
    h.requests[requestBeforeAnotherReconnect].reject(new Error('Old connection history failed'));
    await flush();
    assert.equal(h.render().connectionState, 'connected');
    assert.equal(h.render().historyRefreshError, null, 'an obsolete refresh failure cannot mark a recovered connection as unhealthy');
    assert.equal(h.timers.size, 0, 'an obsolete history request cannot create another retry loop');
    h.render().reset();
  }
  {
    const h = harness();
    const source = await h.load();
    source.open();
    source.emit({ type: 'snapshot', run: live('run-2', 300) });
    useStore.getState().setTaskRun(live('run-2', 300));
    h.respond(1, history(live('run-1', 100, 'done')));
    await flush();
    assert.equal(h.render().isStreaming, true, 'an older history response must preserve a newer active run');
    assert.equal(h.fetchedRuns.at(-1), null, 'an older history response cannot retire a newer board run');
    assert.equal(useStore.getState().taskRuns.get('task-1')?.runId, 'run-2');
    useStore.getState().setTaskRun(live('run-3', 500));
    source.emit({ type: 'snapshot', run: live('run-2', 300, 'done') });
    assert.equal(useStore.getState().taskRuns.get('task-1')?.runId, 'run-3', 'a terminal snapshot cannot clear a newer board run');
    source.error();
    h.render().reset();
    assert.equal(h.render().connectionState, 'connected', 'task reset clears the previous connection warning');
    await h.load();
    source.emit({ type: 'snapshot', run: live('old-source', 500) });
    assert.equal(h.render().messages.length, 0, 'a closed source cannot publish after reopening the same task');
    h.render().reset();
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('Chat reconnect recovery tests passed');
