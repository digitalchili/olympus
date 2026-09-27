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
  const exported: any = {};
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: exported, console, URLSearchParams, requestAnimationFrame() {},
    require: (id: string) => id === 'react' ? hooks : id === 'react-router' ? { useNavigate: () => () => {}, useLocation: () => ({ state: null, search: '', key: 'fixture' }) }
      : id === '../hooks/useAgentConfig' ? { useAgentConfig: () => config }
        : id === '../contexts/ProfileContext' ? { useProfile: () => ({ activeProfileId: 'named', profiles: [] }) }
          : id === '../hooks/useChat' ? { useChat: () => ({ messages: [], activeTools: [], sendMessage: async (...args: any[]) => { sent.push(args); return { ok: true }; } }) }
            : id === '../hooks/useFileAttachments' ? { useFileAttachments: () => ({ pendingFiles: [], submitWithAttachments: (value: string) => value, clearFiles() {}, setUploadError() {} }) }
              : id === '../lib/store' ? { useStore: (selector: any) => selector({ taskRuns: new Map(), taskOutcomes: new Map(), delegationRuns: new Map() }) }
                : id === '../lib/api' ? api : id.startsWith('./') ? new Proxy({}, { get: () => () => null }) : dependency(id),
  });
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
  const render = () => { cursor = 0; return nodes(exported[name]({ taskId: 'fixture', conversationKind: 'bot' })); };
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
}
console.log('Configuration composer safety tests passed');
