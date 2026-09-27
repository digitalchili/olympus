import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function harness() {
  const slots: any[] = []; let cursor = 0; let dirty = false;
  const effects: Array<() => void> = []; const cleanups = new Set<() => void>();
  const timers = new Map<number, { callback: () => void; delay: number; repeat: boolean }>(); let timer = 0;
  const listeners = new Set<() => void>(); let hidden = false; let profile = 'default';
  const requests: Array<{ kind: string; taskId: string; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  const actions: Array<{ resolve: (value: any) => void }> = [];
  const deferred = (kind: string, taskId: string) => new Promise((resolve, reject) => requests.push({ kind, taskId, resolve, reject }));
  const same = (a: any[], b: any[]) => a?.length === b.length && b.every((value, index) => Object.is(a[index], value));
  const react = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value: any) => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(slots[i], next)) { slots[i] = next; dirty = true; } }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback: any, deps: any[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: callback, deps }; return slots[i].value; },
    useEffect(callback: () => void | (() => void), deps: any[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); cleanups.delete(slots[i]?.cleanup); const cleanup = callback(); if (cleanup) cleanups.add(cleanup); slots[i] = { deps, cleanup }; }); },
  };
  const modules = new Map<string, any>();
  function load(relative: string): any {
    if (modules.has(relative)) return modules.get(relative);
    const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exports = {}; modules.set(relative, exports);
    runInNewContext(code, {
      exports, console, Promise,
      require: (name: string) => {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) };
        if (name.includes('useCodingEvidencePolling')) return load('../client/src/hooks/useCodingEvidencePolling.ts');
        if (name.includes('profileQuery')) return { activeProfileIdFromWindow: () => profile };
        if (name.includes('coding-failure')) return { codingFailureDetails: () => ({ summary: 'Failed', excerpt: 'failure' }) };
        if (name === 'lucide-react') return { ChevronRight: () => null };
        if (name.includes('/api')) return {
          fetchCodingEvidence: (id: string) => deferred('evidence', id), fetchTaskRecovery: (id: string) => deferred('recovery', id),
          runCodingVerification: () => new Promise(resolve => actions.push({ resolve })),
          interruptTask: () => Promise.resolve(), pauseTaskRecovery: () => Promise.resolve(),
        };
        throw Error(`Unexpected hook dependency ${name}`);
      },
      document: { get hidden() { return hidden; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) },
      setTimeout: (callback: () => void, delay: number) => { timers.set(++timer, { callback, delay, repeat: false }); return timer; },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: (callback: () => void, delay: number) => { timers.set(++timer, { callback, delay, repeat: true }); return timer; },
      clearInterval: (id: number) => timers.delete(id),
    });
    return exports;
  }
  const { CodingEvidencePanel } = load('../client/src/components/CodingEvidencePanel.tsx');
  let taskId = 'a'; let isStreaming = true; let tree: any;
  function render() { let repeats = 0; do { assert.ok(repeats++ < 20); dirty = false; cursor = 0; tree = CodingEvidencePanel({ taskId, isStreaming }); for (const effect of effects.splice(0)) effect(); } while (dirty); return tree; }
  const evidence = (label: string, status = 'failed') => ({ taskId, runId: label, workdir: '/fixture', status, baseline: { head: 'a'.repeat(40), fingerprint: 'x' }, source: null, checks: [], reason: label, updatedAt: 1 });
  const settle = (index: number, label: string, status = 'failed', recovery: any = null) => { requests[index].resolve({ evidence: evidence(label, status) }); requests[index + 1].resolve({ recovery }); };
  const nodes = (node: any): any[] => !node ? [] : Array.isArray(node) ? node.flatMap(item => nodes(item)) : typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [node];
  return {
    requests, timers, listeners, actions, render, settle, evidence,
    text: () => nodes(tree).filter(node => typeof node === 'string').join(' '),
    click: (label: string) => { const button = nodes(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(button, label); button.props.onClick(); render(); },
    tick: () => { for (const [id, item] of [...timers]) { if (!item.repeat) timers.delete(id); item.callback(); } render(); },
    hide: (value: boolean) => { hidden = value; for (const listener of listeners) listener(); render(); },
    switch: (id: string, nextProfile = profile) => { taskId = id; profile = nextProfile; render(); },
    idle: () => { isStreaming = false; render(); },
    unmount: () => { for (const cleanup of [...cleanups]) cleanup(); cleanups.clear(); },
    async flush() { await new Promise(resolve => setImmediate(resolve)); render(); },
  };
}

{
  const h = harness(); h.render();
  for (let i = 0; i < 5; i++) h.tick();
  assert.equal(h.requests.length, 2, 'Slow evidence/recovery pairs cannot overlap across polling ticks');
  h.hide(true); h.hide(false); h.hide(true); h.hide(false);
  assert.equal(h.requests.length, 2, 'Visibility refresh queues behind the existing pair');
  h.settle(0, 'superseded'); await h.flush();
  assert.equal(h.requests.length, 4, 'Visibility return requires exactly one fresh follow-up');
  assert.doesNotMatch(h.text(), /superseded/);
  h.requests[2].resolve({ evidence: { ...h.evidence('fresh running', 'running'), currentCheck: { command: ['npm', 'test'], output: 'Live command output', startedAt: 1, durationMs: 2000 } } });
  h.requests[3].resolve({ recovery: null }); await h.flush();
  assert.match(h.text(), /Live command output/);
  assert.equal([...h.timers.values()][0]?.delay, 1000);
  h.hide(true); h.tick(); assert.equal(h.requests.length, 4); assert.equal(h.timers.size, 0);
  h.hide(false); assert.equal(h.requests.length, 6);
  h.settle(4, 'fresh passed', 'passed'); await h.flush(); h.idle();
  assert.equal([...h.timers.values()][0]?.delay, 10000);
  h.unmount(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
}
{
  const h = harness(); h.render(); h.switch('b');
  h.settle(2, 'new task'); await h.flush(); h.settle(0, 'old task'); await h.flush();
  assert.match(h.text(), /new task/); assert.doesNotMatch(h.text(), /old task/);
  h.switch('b', 'named'); assert.doesNotMatch(h.text(), /new task/);
  h.settle(4, 'named task'); await h.flush(); assert.match(h.text(), /named task/);
  h.unmount();
}
{
  const h = harness(); h.hide(true); assert.equal(h.requests.length, 0, 'Mounting in a hidden tab does not poll');
  h.hide(false); h.hide(true); h.hide(false); h.hide(true);
  h.settle(0, 'hidden old'); await h.flush();
  assert.equal(h.requests.length, 2, 'A queued visibility refresh waits when the tab becomes hidden again');
  h.hide(false); assert.equal(h.requests.length, 4); h.unmount();
}
{
  const h = harness(); h.render(); h.settle(0, 'first'); await h.flush(); h.idle();
  h.click('Run checks'); h.switch('b'); h.settle(2, 'second'); await h.flush();
  assert.doesNotMatch(h.text(), /Running checks|Starting checks/, 'An old task action cannot keep the new task busy');
  h.actions[0].resolve({ evidence: h.evidence('old action') }); await h.flush();
  assert.equal(h.requests.length, 4, 'An old action completion must not refresh the new task');
  assert.match(h.text(), /second/); h.unmount();
}
{
  const h = harness(); h.render(); h.requests[0].reject(new Error('evidence unavailable')); await h.flush();
  h.tick(); assert.equal(h.requests.length, 2, 'One failed member must still wait for its slow peer');
  h.requests[1].resolve({ recovery: null }); await h.flush(); h.tick(); assert.equal(h.requests.length, 4);
  h.settle(2, 'recovered'); await h.flush(); h.idle(); h.tick();
  h.click('Run checks'); h.actions[0].resolve({ evidence: h.evidence('new action', 'passed') }); await h.flush();
  assert.equal(h.requests.length, 6, 'Explicit action refresh must queue while a pair remains in flight');
  h.settle(4, 'older read'); await h.flush(); assert.equal(h.requests.length, 8);
  assert.doesNotMatch(h.text(), /older read/);
  h.settle(6, 'action fresh', 'failed', { kind: 'verification', state: 'waiting', waitReason: 'queued_message' }); await h.flush();
  assert.match(h.text(), /action fresh/); assert.match(h.text(), /Paused for your queued message/);
  h.click('Pause automatic repair'); await h.flush(); assert.equal(h.requests.length, 10, 'Explicit recovery actions refresh promptly');
  h.unmount(); h.settle(8, 'after unmount'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
}
console.log('Real evidence panel polling, visibility, generation, action and recovery tests passed');
