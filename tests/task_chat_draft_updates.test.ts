import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Run the real composer's effects, including rehydration, with controlled transport.
// Unlike send-only tests, this catches draft resets caused by background updates.
function composer() {
  const dependency = createRequire(import.meta.url);
  const slots: any[] = [], effects: Array<() => void> = [];
  let cursor = 0, dirty = false, taskId = 'task-one', profileId = 'default';
  let updatedAt = 1, queuedMessage: any = null, loads = 0, sends = 0;
  let loadMessages = async () => { loads++; return []; };
  const sendMessage = async () => { sends++; return { ok: true }; };
  const memo = (create: () => any, deps: unknown[]) => {
    const at = cursor++, previous = slots[at];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) slots[at] = { value: create(), deps };
    return slots[at].value;
  };
  const effect = (run: () => any, deps: unknown[]) => {
    const at = cursor++, previous = slots[at];
    if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps?.[i]))) {
      slots[at] = { deps };
      effects.push(() => { previous?.cleanup?.(); slots[at].cleanup = run(); });
    }
  };
  const hooks = { ...dependency('react'),
    useState(initial: any) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { value: typeof initial === 'function' ? initial() : initial,
        set(next: any) {
          const value = typeof next === 'function' ? next(slots[at].value) : next;
          if (!Object.is(value, slots[at].value)) { slots[at].value = value; dirty = true; }
        } };
      return [slots[at].value, slots[at].set];
    },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback: (fn: any, deps: unknown[]) => memo(() => fn, deps), useMemo: memo,
    useEffect: effect, useLayoutEffect: effect,
  };
  function load(path: string, overrides: Record<string, any>) {
    const file = new URL(path, import.meta.url), require = createRequire(file), exports: any = {};
    runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, console, URL, File, AbortController, DOMException, setTimeout, clearTimeout,
      requestAnimationFrame() {}, window: { setTimeout, clearTimeout },
      require: (id: string) => id === 'react' ? hooks : overrides[id] ?? (
        id.startsWith('./') && id !== './ChatAttachments' ? new Proxy({}, { get: () => () => null }) : require(id)
      ),
    });
    return exports;
  }
  const attachments = load('../client/src/hooks/useFileAttachments.ts', { '../lib/api': {
    uploadChatAttachment: async () => '/workspace/draft.png', deleteFileEntry: async () => {},
  } });
  const component = load('../client/src/components/TaskChat.tsx', {
    '../hooks/useFileAttachments': attachments,
    '../hooks/useProjectSecretEntry': { useProjectSecretEntry: () => ({}) },
    '../hooks/useAgentConfig': { useAgentConfig: () => ({ defaults: {}, modelGroups: [] }) },
    '../contexts/ProfileContext': { useProfile: () => ({ activeProfileId: profileId }) },
    '../hooks/useChat': { useChat: () => ({ messages: [], activeTools: [], isStreaming: true, sendMessage, loadMessages }) },
    '../lib/store': { useStore: (select: any) => select({ tasks: [{ id: taskId, updated_at: updatedAt }], taskRuns: new Map(), taskOutcomes: new Map(), delegationRuns: new Map() }) },
    '../lib/api': { fetchQueuedTaskMessage: async () => ({ queuedMessage }),
      fetchHermesProfiles: async () => ({ profiles: [] }), fetchCollaborationGrants: async () => ({ grants: [] }) },
  });
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props
    ? [node, ...nodes(node.props.children)] : [];
  let tree: any;
  const render = () => { cursor = 0; dirty = false; tree = component.TaskChat({ taskId }); while (effects.length) effects.shift()!(); };
  const flush = async () => { for (let i = 0; i < 15; i++) { render(); await new Promise(resolve => setImmediate(resolve)); if (!dirty) return; } throw new Error('Composer did not settle'); };
  const input = () => nodes(tree).find(node => node.type === 'textarea');
  return { flush, input,
    counts: () => ({ loads, sends }),
    type(value: string) { input().props.onChange({ target: { value, selectionStart: value.length } }); },
    async attach() { nodes(tree).find(node => node.type?.name === 'AttachButton').props.onFiles([new File(['draft'], 'draft.png')]); await flush(); },
    files: () => nodes(tree).find(node => node.type?.name === 'AttachmentTray').props.files,
    async publish() { queuedMessage = { id: 'push-one', content: 'Commit & Push to main', settings: {}, invitedProfileIds: [], updatedAt: 2, publication: { targetBranch: 'main' } }; updatedAt++; await flush(); },
    async finishPush() { queuedMessage = null; updatedAt++; await flush(); },
    async refreshChat() { loadMessages = async () => { loads++; return []; }; await flush(); },
    async navigate(task: string, profile = profileId) { taskId = task; profileId = profile; await flush(); },
    queueInsideComposer() {
      assert.equal(nodes(tree).filter(node => node.type?.name === 'QueuedMessageBar').length, 1, 'the saved push remains visible exactly once');
      const container = nodes(tree).find(node => node.props.children && nodes(node.props.children).some(child => child === input()) && /rounded-xl border/.test(node.props.className ?? ''));
      assert.ok(container, 'the composer containing the textarea is rendered');
      return nodes(container).some(node => node.type?.name === 'QueuedMessageBar');
    },
  };
}

const h = composer(); await h.flush();
h.type('Next, add a customer search'); await h.attach();
await h.publish();
assert.equal(h.input().props.value, 'Next, add a customer search', 'a saved push must preserve the next unsent message');
await h.refreshChat();
assert.equal(h.input().props.value, 'Next, add a customer search', 'rehydrating this conversation must not erase its draft');
assert.equal(h.files().length, 1, 'rehydration must also preserve staged attachments');
assert.equal(h.counts().sends, 0, 'status refresh must not submit the draft or repeat the push');
assert.equal(h.queueInsideComposer(), false, 'publication status must be outside the editable composer');
await h.finishPush();
assert.equal(h.input().props.value, 'Next, add a customer search', 'completed publication leaves the next draft intact');
assert.equal(h.files().length, 1);
await h.navigate('task-two');
assert.equal(h.input().props.value, '', 'a different conversation starts with its own composer');
assert.equal(h.files().length, 0);
h.type('Other profile draft'); await h.flush(); await h.navigate('task-two', 'other-profile');
assert.equal(h.input().props.value, '', 'profile changes cannot carry a draft into another profile');
console.log('Task chat background updates preserve unsent drafts and attachments');
