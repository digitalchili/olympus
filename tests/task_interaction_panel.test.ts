import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { TaskInteraction } from '../shared/interactions.js';

const file = new URL('../client/src/components/TaskInteractionPanel.tsx', import.meta.url);
const dependency = createRequire(file);
const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const interaction = (overrides: Partial<TaskInteraction> = {}): TaskInteraction => ({
  id: 'answer-one', taskId: 'task-one', profileName: 'default', olympusRunId: 'run-one', workerRunId: 'worker-one',
  kind: 'approval', title: 'Continue?', questions: [], expiresAt: 0, requestedAt: 0,
  status: 'answered', settledAt: 1_000, response: { decision: 'once' }, ...overrides,
});

// Render the production component with controlled hook scheduling and a clock.
// Reading markup never rerenders: expiry must be driven by the component's timer.
function panel(initial: TaskInteraction[]) {
  const slots: any[] = [], effects: Array<() => void> = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let cursor = 0, dirty = true, now = 1_000, nextTimer = 0;
  let items = initial, tree: any, markup = '';
  const hooks = {
    useState(initial: any) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], (value: any) => {
        const next = typeof value === 'function' ? value(slots[at]) : value;
        if (!Object.is(next, slots[at])) { slots[at] = next; dirty = true; }
      }];
    },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback(callback: any, deps: unknown[]) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) slots[at] = { deps, callback };
      return slots[at].callback;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        const current = slots[at] = { deps, cleanup: undefined as void | (() => void) };
        effects.push(() => { previous?.cleanup?.(); current.cleanup = effect(); });
      }
    },
  };
  const exports: any = {};
  runInNewContext(source, { exports, Date: { now: () => now }, window: {
    setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); }, clearInterval() {},
  }, require: (name: string) => name === 'react' ? hooks : name === '../lib/api' ? {
    fetchTaskInteractions: async () => ({ interactions: items }),
    respondTaskInteraction: async () => { items = items.map(item => ({ ...item, status: 'answered', settledAt: now, response: { decision: 'once' } })); },
  } : dependency(name) });
  const flushRender = () => {
    while (dirty) {
      dirty = false; cursor = 0;
      tree = exports.TaskInteractionPanel({ taskId: 'task-one', isStreaming: false });
      markup = renderToStaticMarkup(tree);
      effects.splice(0).forEach(effect => effect());
    }
  };
  const flush = async () => { flushRender(); await new Promise(resolve => setImmediate(resolve)); flushRender(); };
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
  return {
    flush, markup: () => markup,
    async click(label: string) { nodes(tree).find(node => node.type === 'button' && node.props.children === label).props.onClick(); await flush(); },
    replace(next: TaskInteraction[]) { items = next; },
    advance(to: number, earlyBy = 0) {
      now = to;
      for (const [id, timer] of timers) {
        if (timer.at <= now + earlyBy) { timers.delete(id); timer.callback(); }
      }
      flushRender();
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    timerCount: () => timers.size,
  };
}

{
  const h = panel([interaction({ status: 'waiting', settledAt: null, response: null })]);
  await h.flush(); await h.click('Approve once');
  assert.match(h.markup(), /Answer submitted/);
  h.advance(60_999);
  assert.match(h.markup(), /Answer submitted/, 'a recent confirmation remains visible for a minute');
  h.advance(61_000);
  assert.equal(h.markup(), '', 'submitted confirmation disappears without polling, clicking or remounting');
  h.unmount();
}
{
  const h = panel([interaction()]); await h.flush();
  // Browser timers and Date.now can straddle the deadline. No later events occur.
  h.advance(60_999, 1);
  h.advance(61_000);
  assert.equal(h.markup(), '', 'an early timer callback must not leave the confirmation stuck indefinitely');
  h.unmount();
}
{
  const h = panel([interaction({ settledAt: -60_000 })]); await h.flush();
  assert.equal(h.markup(), '', 'already expired confirmations stay hidden on mount'); h.unmount();
}
for (const status of ['waiting', 'claimed', 'delivery_unknown'] as const) {
  const h = panel([interaction({ status, settledAt: null, response: null })]); await h.flush();
  h.advance(121_000);
  assert.notEqual(h.markup(), '', `${status} interactions must not disappear without resolution`);
  h.unmount();
}
{
  const h = panel([interaction()]); await h.flush();
  h.advance(31_000);
  h.replace([interaction({ id: 'answer-two', settledAt: 31_000 })]); await h.click('Refresh');
  h.advance(61_000);
  assert.match(h.markup(), /Answer submitted/, 'an older timer cannot hide the next answer');
  h.advance(91_000);
  assert.equal(h.markup(), ''); h.unmount();
}
{
  const h = panel([interaction()]); await h.flush();
  assert.equal(h.timerCount(), 1); h.unmount();
  assert.equal(h.timerCount(), 0, 'leaving the task cancels the confirmation timer');
}
console.log('Task interaction confirmation expiry tests passed');
