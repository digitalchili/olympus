import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise both production composers. Unrelated child panels are not rendered;
// settings and task submission are controlled at their hook/API boundaries.
function composer(name: 'TaskChat' | 'NewTaskPage') {
  const file = new URL(`../client/src/components/${name}.tsx`, import.meta.url);
  const dependency = createRequire(file), slots: any[] = [], sent: any[] = [];
  let cursor = 0, retries = 0;
  const config: any = { defaults: { model: 'default-model', provider: 'default-provider', reasoningEffort: 'medium' },
    modelGroups: [], model: 'saved-model', provider: 'saved-provider', reasoningEffort: 'high', isLoading: false,
    isLoadingModels: true, settingsError: 'Could not load saved settings.', retrySettings: () => retries++,
    setModel() {}, setProvider() {}, setReasoningEffort() {} };
  const hooks = { ...dependency('react'), useState(initial: any) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
    return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }]; },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback: (value: any) => value, useMemo: (fn: any) => fn(), useEffect() {}, useLayoutEffect() {} };
  const api = { createTask: async (...args: any[]) => { sent.push(args); return { task: { id: 'created', handling_profile_id: 'named' } }; } };
  const load = (file: URL): any => {
  const dependency = createRequire(file), exported: any = {};
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: exported, console, URLSearchParams, URL, File, TextEncoder, AbortController, DOMException, setTimeout, clearTimeout, requestAnimationFrame() {},
    require: (id: string) => id === 'react' ? hooks : id === 'react-router' ? { useNavigate: () => () => {}, useLocation: () => ({ state: null, search: '', key: 'fixture' }) }
      : id === '../hooks/useProjectSecretEntry' ? load(new URL('../client/src/hooks/useProjectSecretEntry.tsx', import.meta.url))
      : id === '../hooks/useAgentConfig' ? { useAgentConfig: () => config }
        : id === '../contexts/ProfileContext' ? { useProfile: () => ({ activeProfileId: 'named', profiles: [] }) }
          : id === '../hooks/useChat' ? { useChat: () => ({ messages: [], activeTools: [], sendMessage: async (...args: any[]) => { sent.push(args); return { ok: true }; } }) }
            : id === '../hooks/useFileAttachments' ? load(new URL('../client/src/hooks/useFileAttachments.ts', import.meta.url))
              : id === '../lib/store' ? { useStore: (selector: any) => selector({ taskRuns: new Map(), taskOutcomes: new Map(), delegationRuns: new Map() }) }
                : id === '../lib/api' ? api : id.startsWith('./') ? new Proxy({}, { get: () => () => null }) : dependency(id),
  });
  return exported;
  };
  const exported = load(file);
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
  const render = () => { cursor = 0; return nodes(exported[name]({ taskId: 'fixture', conversationKind: 'task' })); };
  return { config, sent, render, retries: () => retries };
}

for (const name of ['TaskChat', 'NewTaskPage'] as const) {
  const h = composer(name);
  const textarea = h.render().find(node => node.type === 'textarea');
  assert.ok(!textarea.props.disabled, `${name}: a settings error must leave draft editing available`);
  textarea.props.onChange({ target: { value: 'Keep this draft', selectionStart: 15 } });
  let send = h.render().find(node => node.type === 'button' && node.props['aria-label'] === 'Send message');
  assert.ok(send?.props.disabled, `${name}: a settings error blocks sending with cached/default settings`);
  await send.props.onClick(); assert.equal(h.sent.length, 0);
  const retry = h.render().find(node => node.type === 'button' && node.props.children === 'Retry settings');
  assert.ok(retry); retry.props.onClick(); assert.equal(h.retries(), 1);
  assert.equal(h.render().find(node => node.type === 'textarea').props.value, 'Keep this draft');
  h.config.settingsError = null;
  send = h.render().find(node => node.type === 'button' && node.props['aria-label'] === 'Send message');
  assert.ok(!send.props.disabled, `${name}: the optional catalog does not block verified settings`);
  await send.props.onClick(); assert.equal(h.sent.length, 1);
  const selected = name === 'TaskChat' ? h.sent[0][2] : h.sent[0][3].initialMessage.settings;
  assert.deepEqual({ model: selected.model, provider: selected.provider, reasoningEffort: selected.reasoningEffort },
    { model: 'saved-model', provider: 'saved-provider', reasoningEffort: 'high' });
  const secretComposer = composer(name);
  const pasted = 'API_KEY=example-from-documentation';
  let prevented = false;
  secretComposer.render().find(node => node.type === 'textarea').props.onPaste({
    clipboardData: { items: [], getData: () => pasted }, currentTarget: { selectionStart: 0, selectionEnd: 0 },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false, `${name}: pasted assignments must remain ordinary text`);
  assert.ok(!secretComposer.render().some(node => node.props.draft), `${name}: paste must not open secret entry`);
  secretComposer.render().find(node => node.type === 'textarea').props.onChange({ target: { value: pasted, selectionStart: pasted.length } });
  let secretSend = secretComposer.render().find(node => node.type === 'button' && node.props['aria-label'] === 'Send message');
  assert.ok(secretSend.props.disabled, `${name}: every ordinary message uses normal settings readiness`);
  // Secret entry is independent of the model, but must be explicitly selected.
  secretComposer.render().find(node => node.type === 'button' && node.props.children === 'Add secret').props.onClick();
  let dialog = secretComposer.render().find(node => node.props.draft);
  assert.ok(dialog, `${name}: Add secret opens the explicit form`);
  assert.equal(Object.keys(dialog.props.draft).length, 0, 'the form does not infer or copy values from the chat draft');
  assert.equal(secretComposer.render().find(node => node.type === 'textarea').props.value, pasted);
  dialog.props.onClose();
  secretComposer.config.settingsError = null;
  secretSend = secretComposer.render().find(node => node.type === 'button' && node.props['aria-label'] === 'Send message');
  assert.ok(!secretSend.props.disabled);
  await secretSend.props.onClick();
  assert.equal(secretComposer.sent.length, 1, `${name}: Send delivers the pasted text normally`);
  assert.equal(name === 'TaskChat' ? secretComposer.sent[0][1] : secretComposer.sent[0][3].initialMessage.content, pasted);
  assert.ok(!secretComposer.render().some(node => node.props.draft), `${name}: Send must not reopen secret entry`);
}
console.log('Configuration composer and explicit-only secret entry tests passed');
