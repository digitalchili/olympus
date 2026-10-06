import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const { ApiError } = createRequire(import.meta.url)('../client/src/lib/api.ts');

// Render the production composer and its queue bar, controlling only external
// hooks and APIs. Clicks exercise the real queue and steer handlers.
function composer() {
  const file = new URL('../client/src/components/TaskChat.tsx', import.meta.url);
  const dependency = createRequire(file), slots: any[] = [];
  let cursor = 0, saved: any = null, deleted = 0, sent = 0;
  let steer: (content: string) => Promise<{ steered: boolean; queued: boolean }> = async () => ({ steered: false, queued: true });
  const hooks = { ...dependency('react'),
    useState(initial: any) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }];
    },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(), useEffect() {}, useLayoutEffect() {},
  };
  const exported: any = {};
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports: exported, console, setTimeout, clearTimeout, requestAnimationFrame() {},
    require: (id: string) => {
      if (id === 'react') return hooks;
      if (id === '../hooks/useProjectSecretEntry') return { useProjectSecretEntry: () => ({}) };
      if (id === '../hooks/useAgentConfig') return { useAgentConfig: () => ({ defaults: {}, modelGroups: [] }) };
      if (id === '../contexts/ProfileContext') return { useProfile: () => ({ activeProfileId: 'named' }) };
      if (id === '../hooks/useChat') return { useChat: () => ({
        messages: [], activeTools: [], isStreaming: true,
        sendMessage: async () => { sent++; saved = null; return { ok: true }; },
      }) };
      if (id === '../hooks/useFileAttachments') return { useFileAttachments: () => ({ pendingFiles: [], submitWithAttachments: (text: string) => text }) };
      if (id === '../lib/store') return { useStore: (select: any) => select({ tasks: [], taskRuns: new Map(), taskOutcomes: new Map(), delegationRuns: new Map() }) };
      if (id === '../lib/api') return {
        ApiError,
        putQueuedTaskMessage: async (_taskId: string, message: any) => { saved = message; return { queuedMessage: message }; },
        steerTask: async (_taskId: string, content: string) => steer(content),
        deleteQueuedTaskMessage: async (_taskId: string, id: string) => { assert.equal(id, saved.id); deleted++; saved = null; },
      };
      if (id.startsWith('./')) return new Proxy({}, { get: () => () => null });
      return dependency(id);
    },
  });
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props
    ? [node, ...nodes(node.type?.name === 'QueuedMessageBar' ? node.type(node.props) : node.props.children)] : [];
  const render = () => { cursor = 0; return nodes(exported.TaskChat({ taskId: 'fixture' })); };
  const queueBar = () => render().find(node => node.type?.name === 'QueuedMessageBar');
  return { render, queueBar, setSteer: (fn: typeof steer) => { steer = fn; },
    publicationBar: (overrides: any = {}) => nodes(exported.QueuedMessageBar({
      ...queueBar().props, queuedMessage: { ...saved, publication: { projectId: 'project', ...overrides } },
      error: null,
      onReviewPublication() {},
    })),
    saved: () => saved, deleted: () => deleted, sent: () => sent,
    async queue(content: string) {
      render().find(node => node.type === 'textarea').props.onChange({ target: { value: content, selectionStart: content.length } });
      render().find(node => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(saved, 'Enter queues the draft while streaming');
    },
  };
}

const content = 'Apply this review.\n\n[Attached files:\n- /workspace/uploads/clipboard-paste.txt]';
const h = composer();
await h.queue(content);
let resolveSteer!: (result: { steered: boolean; queued: boolean }) => void;
h.setSteer(async text => { assert.equal(text, content); return await new Promise(resolve => { resolveSteer = resolve; }); });
h.queueBar().props.onSteer();
assert.equal(h.render().find(node => node.props.role === 'status')?.props.children, 'Sending update…');
assert.ok(h.render().find(node => node.type === 'button' && node.props.children === 'Steering…')?.props.disabled);
resolveSteer({ steered: false, queued: true });
await new Promise(resolve => setImmediate(resolve));
assert.match(h.render().find(node => node.props.role === 'status')?.props.children, /Saved to send after this response/);
assert.equal(h.saved().content, content, 'declined steering preserves the complete durable follow-up');
assert.equal(h.deleted(), 0);

h.setSteer(async () => ({ steered: true, queued: false }));
h.queueBar().props.onSteer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(h.queueBar(), undefined, 'accepted steering removes the queue bar');
assert.equal(h.deleted(), 1);
assert.equal(h.sent(), 0, 'accepted steering does not also start a follow-up');

await h.queue('A second update');
assert.equal(h.queueBar().props.waitingLabel, 'Sends after current response', 'a new queued message must not inherit an earlier declined notice');
h.setSteer(async () => { throw new ApiError('Run already finished', 409); });
h.queueBar().props.onSteer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(h.sent(), 1, 'a completion race sends one normal follow-up');
assert.equal(h.queueBar(), undefined);

await h.queue('Keep this update if steering fails');
h.setSteer(async () => { throw new ApiError('Worker unavailable', 503); });
h.queueBar().props.onSteer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(h.render().find(node => node.props.role === 'alert')?.props.children, 'Worker unavailable');
assert.equal(h.saved().content, 'Keep this update if steering fails');
let publicationNodes = h.publicationBar();
assert.ok(publicationNodes.some(node => node.props.children === 'Publishes after this response and its checks finish.'));
assert.ok(!publicationNodes.some(node => ['Steer now', 'Edit', 'Retry'].includes(node.props.children)), 'a saved publication is never steered or edited as chat text');
assert.ok(publicationNodes.some(node => node.props['aria-label'] === 'Cancel queued publication' && !node.props.disabled));
publicationNodes = h.publicationBar({ started: true });
assert.ok(publicationNodes.some(node => node.props.children === 'Publishing to GitHub…'));
assert.ok(publicationNodes.some(node => node.props['aria-label'] === 'Cancel queued publication' && node.props.disabled));
publicationNodes = h.publicationBar({ error: 'Files changed. Review before publishing.' });
assert.ok(publicationNodes.some(node => node.props.children === 'Review'));
assert.ok(publicationNodes.some(node => node.props.children === 'Files changed. Review before publishing.'));
console.log('Queued steering composer feedback tests passed');
