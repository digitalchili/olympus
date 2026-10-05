import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';

function loadHooks(file: URL, overrides: Record<string, unknown> = {}, environment: Record<string, unknown> = {}) {
  const dependency = createRequire(file), slots: any[] = [];
  let cursor = 0;
  const effects: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
  const hooks = { ...dependency('react'), useState(initial: any) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
    return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }]; },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; },
    useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(), useEffect(fn: () => void | (() => void), deps: unknown[] = []) { const at = cursor++; if (!slots[at] || deps.some((dep, i) => dep !== slots[at][i])) { slots[at] = deps; effects.push(fn); } } };
  const testHooks = { ...hooks, useLayoutEffect: hooks.useEffect };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, console, AbortController, DOMException, URL, File, TextEncoder, setTimeout, clearTimeout, ...environment,
    require: (name: string) => name === 'react' ? testHooks : overrides[name] ?? dependency(name) });
  return { exports, render(fn: () => any, beforeEffects?: (tree: any) => void) { cursor = 0; const result = fn(); beforeEffects?.(result); for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } return result; }, unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); } };
}
let uploads = 0;
const attachments = loadHooks(new URL('../client/src/hooks/useFileAttachments.ts', import.meta.url), {
  '../lib/api': { uploadChatAttachment: async () => { uploads++; return 'uploaded'; } },
});
const files = attachments.render(() => attachments.exports.useFileAttachments('task-test', { value: 'Keep this draft: ', setValue() {} }));
for (const text of ['API_KEY=example', 'Explain PASSWORD=example', '/secrets\nLOCAL_VALUE=example']) {
  let prevented = false;
  files.handlePaste({ clipboardData: { items: [], getData: () => text }, currentTarget: { selectionStart: 17, selectionEnd: 17 }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'ordinary pasted text uses native textarea insertion');
}
const longText = `API_KEY=example-${'x'.repeat(5000)}`;
let attached = false;
files.handlePaste({ clipboardData: { items: [], getData: () => longText }, currentTarget: { selectionStart: 17, selectionEnd: 17 }, preventDefault() { attached = true; } });
assert.equal(attached, true, 'large pastes keep the usual text attachment behavior');
assert.equal(uploads, 1);
files.addFiles([new File(['synthetic'], '.env.local')]);
assert.equal(uploads, 1, 'dotenv file attachment policy remains separate from text paste');
const updatedFiles = attachments.render(() => attachments.exports.useFileAttachments('task-test', { value: '', setValue() {} }));
assert.match(updatedFiles.uploadError, /choose Add secret/);
attachments.unmount();

const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit; resolve: (response: Response) => void }> = [];
globalThis.fetch = (url, init) => new Promise(resolve => requests.push({ url: String(url), init, resolve }));
try {
  const secret = 'synthetic-value-not-for-chat';
  const dialog = loadHooks(new URL('../client/src/components/SecretEntryDialog.tsx', import.meta.url));
  const saved: unknown[] = [];
  const props = { draft: { entries: [{ name: 'API_KEY', value: secret }] }, projectId: 'project/one', taskId: 'task-one', onClose() {}, onSaved: (...args: unknown[]) => saved.push(args) };
  const render = () => dialog.render(() => dialog.exports.SecretEntryDialog(props));
  assert.match(renderToStaticMarkup(render()), /API_KEY/);
  assert.ok(!renderToStaticMarkup(render()).includes(secret), 'staged secrets render only names and masking');
  const form = nodes(render()).find(node => node.type === 'form');
  form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
  assert.equal(requests.length, 1, 'double submit saves once');
  assert.equal(requests[0].url, '/api/projects/project%2Fone/secrets');
  assert.equal(requests[0].init?.method, 'PUT');
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-Olympus-Secret-Entry'], '1');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { entries: props.draft.entries, taskId: 'task-one' });
  requests[0].resolve(Response.json({ error: secret }, { status: 500 })); await flush();
  assert.match(renderToStaticMarkup(render()), /Could not save secrets/);
  assert.ok(!renderToStaticMarkup(render()).includes(secret), 'an upstream echo cannot leak a value through the error UI');
  nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  requests[1].resolve(Response.json({ secrets: [{ name: 'API_KEY', updatedAt: 1 }], savedNames: ['API_KEY'] })); await flush();
  assert.equal(saved.length, 1); assert.ok(!JSON.stringify(saved).includes(secret));

  const picker = loadHooks(new URL('../client/src/components/SecretEntryDialog.tsx', import.meta.url));
  let picked: unknown[] | undefined;
  const pickerProps = { draft: props.draft, taskId: 'inbox', onClose() {}, onSaved: (...args: unknown[]) => { picked = args; } };
  const renderPicker = () => picker.render(() => picker.exports.SecretEntryDialog(pickerProps));
  renderPicker();
  requests[2].resolve(Response.json({ projects: [{ id: 'chosen', name: 'Chosen project' }] })); await flush();
  assert.ok(nodes(renderPicker()).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, 'Inbox requires an explicit project choice');
  nodes(renderPicker()).find(node => node.type === 'select').props.onChange({ target: { value: 'chosen' } });
  nodes(renderPicker()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(requests[3].url, '/api/projects/chosen/secrets');
  assert.equal(JSON.parse(String(requests[3].init?.body)).taskId, 'inbox');
  requests[3].resolve(Response.json({ secrets: [], savedNames: ['API_KEY'] })); await flush();
  assert.equal(picked?.[2], 'Chosen project');

  const hook = loadHooks(new URL('../client/src/hooks/useProjectSecretEntry.tsx', import.meta.url));
  const context = { projectId: 'one', taskId: 'task-one' };
  let entry = hook.render(() => hook.exports.useProjectSecretEntry(context));
  assert.equal(entry.dialog, null, 'secret entry starts closed');
  entry.open();
  entry = hook.render(() => hook.exports.useProjectSecretEntry(context));
  const oldDialog = entry.dialog;
  assert.equal(Object.keys(oldDialog.props.draft).length, 0, 'explicit entry starts blank');
  context.projectId = 'two';
  entry = hook.render(() => hook.exports.useProjectSecretEntry(context));
  assert.equal(entry.dialog, null, 'switching projects drops the staged secret UI');
  oldDialog.props.onSaved(['API_KEY'], 'one', 'Original');
  entry = hook.render(() => hook.exports.useProjectSecretEntry(context));
  assert.equal(entry.notice, null, 'a stale save response must not appear in another project');
} finally { globalThis.fetch = originalFetch; }
const question = loadHooks(new URL('../client/src/components/TaskInteractionPanel.tsx', import.meta.url));
const deliveredAnswers: unknown[] = [];
const questionProps = { item: { id: 'question-test', kind: 'clarification', questions: [{ id: 'free-text', question: 'Which connection?', choices: [], multiSelect: false }] }, busy: false,
  onSubmit: (response: unknown) => deliveredAnswers.push(response) };
const renderQuestion = () => question.render(() => question.exports.TaskQuestionForm(questionProps));
nodes(renderQuestion()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'API_KEY=synthetic-value' } });
assert.ok(!renderToStaticMarkup(renderQuestion()).includes('Use Add secret'));
assert.ok(!nodes(renderQuestion()).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled);
nodes(renderQuestion()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
assert.deepEqual(JSON.parse(JSON.stringify(deliveredAnswers)), [{ answers: { 'free-text': 'API_KEY=synthetic-value' } }], 'question answers are not classified as secrets');
nodes(renderQuestion()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Use the local test connection' } });
nodes(renderQuestion()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
assert.equal(deliveredAnswers.length, 2, 'normal answers remain usable');
// A minimal DOM boundary verifies focus movement without mocking the dialog logic.
const listeners = new Map<string, Set<(event: any) => void>>();
const documentFixture: any = {
  activeElement: null,
  addEventListener(type: string, handler: (event: any) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(handler); },
  removeEventListener(type: string, handler: (event: any) => void) { listeners.get(type)?.delete(handler); },
};
const element = (name: string): any => ({ name, disabled: false, isConnected: true, focus() { documentFixture.activeElement = this; for (const listener of listeners.get('focusin') ?? []) listener({ target: this }); } });
const priorFocus = element('chat composer'), different = element('different secrets'), cancel = element('cancel'), saveButton = element('save'), maskedEntry = element('masked entry'), projectSelect = element('project');
let focusables = [different, cancel, saveButton];
let preferred = saveButton;
const formElement = Object.assign(element('dialog'), {
  contains(target: any) { return target === this || focusables.includes(target); },
  querySelector() { return preferred.disabled ? null : preferred; },
  querySelectorAll() { return focusables.filter(item => !item.disabled); },
});
priorFocus.focus();
const focusDialog = loadHooks(new URL('../client/src/components/SecretEntryDialog.tsx', import.meta.url), {}, { document: documentFixture });
const focusProps: any = { draft: { entries: [{ name: 'API_KEY', value: 'synthetic' }] }, projectId: 'one', onClose() {}, onSaved() {} };
const renderFocus = () => focusDialog.render(() => focusDialog.exports.SecretEntryDialog(focusProps), tree => {
  const form = nodes(tree).find(node => node.type === 'form');
  if (form.props.ref) form.props.ref.current = formElement;
});
renderFocus();
assert.equal(documentFixture.activeElement, saveButton, 'explicit secret entry must focus the secret confirmation');
const tab = (shiftKey = false) => { let prevented = false; for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Tab', shiftKey, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };
assert.ok(tab()); assert.equal(documentFixture.activeElement, different, 'Tab wraps from last to first dialog control');
assert.ok(tab(true)); assert.equal(documentFixture.activeElement, saveButton, 'Shift+Tab wraps backwards within the dialog');
priorFocus.focus(); assert.equal(documentFixture.activeElement, saveButton, 'programmatic focus cannot return typing to underlying chat');
focusables = [maskedEntry, cancel, saveButton]; preferred = maskedEntry;
nodes(renderFocus()).find(node => node.type === 'button' && node.props.children === 'Enter different secrets').props.onClick();
renderFocus(); assert.equal(documentFixture.activeElement, maskedEntry, 'switching to entry mode focuses the masked field');
focusDialog.unmount();
assert.equal(documentFixture.activeElement, priorFocus, 'closing secret entry restores the original composer focus');
assert.equal(listeners.get('keydown')?.size, 0, 'closing removes keyboard focus containment');

priorFocus.focus();
focusables = [projectSelect, cancel, saveButton]; preferred = projectSelect; projectSelect.disabled = true;
const projectDialog = loadHooks(new URL('../client/src/components/SecretEntryDialog.tsx', import.meta.url), { '../lib/api': { fetchProjects: async () => ({ projects: [{ id: 'one', name: 'One' }] }) } }, { document: documentFixture });
const renderProjectFocus = () => projectDialog.render(() => projectDialog.exports.SecretEntryDialog({ ...focusProps, projectId: null }), tree => { const form = nodes(tree).find(node => node.type === 'form'); if (form.props.ref) form.props.ref.current = formElement; });
renderProjectFocus(); assert.equal(documentFixture.activeElement, formElement, 'loading project choices must still remove focus from chat');
await flush(); projectSelect.disabled = false;
renderProjectFocus(); assert.equal(documentFixture.activeElement, projectSelect, 'project picker receives focus once choices load');
projectDialog.unmount();
console.log('Project secret UI tests passed');
