import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { HermesUpdateStatus } from '../shared/hermes-updates.js';

const file = new URL('../client/src/components/HermesUpdateSettings.tsx', import.meta.url);
assert.ok(existsSync(file), 'Settings Updates needs a Hermes runtime update card');
const { HermesUpdateCard, HermesUpdateConfirmDialog } = await import('../client/src/components/HermesUpdateSettings.js');
const currentRevision = 'a'.repeat(40), targetRevision = 'b'.repeat(40);
const status: HermesUpdateStatus = {
  current: { available: true, version: '0.21.0', revision: currentRevision, installation: 'source', sourcePath: null, pythonPath: null, dirty: false },
  target: { schemaVersion: 1, version: '0.22.0', revision: targetRevision, image: 'ghcr.io/digitalchili/hermes:tested', releaseUrl: 'https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0' },
  olympusVersion: '0.7.23', targetOlympusVersion: '0.7.24', method: 'native', updateAvailable: true, canApply: true, reason: null, operation: null, checkedAt: 1,
};
const card = (next: HermesUpdateStatus | null, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(HermesUpdateCard, {
  status: next, loading: false, applying: false, observingRequest: false, error: null, onRefresh() {}, onRequestUpdate() {}, ...extra,
}));
assert.match(card(status), /Hermes agent/);
assert.match(card(status), /Running version/);
assert.match(card(status), /Latest compatible/);
assert.match(card(status), /v0\.21\.0/);
assert.match(card(status), /v0\.22\.0/);
assert.match(card(status), /Release notes/);
assert.doesNotMatch(card(status), /data-hermes-update-action="true"[^>]* disabled=""/);
assert.match(card({ ...status, method: 'dokploy', canApply: false, reason: 'Configure the installation-local updater.' }), /Dokploy/);
assert.match(card({ ...status, method: 'docker', canApply: false }), /data-hermes-update-action="true"[^>]* disabled=""/);
assert.match(card({ ...status, current: { ...status.current, installation: 'docker' }, method: 'unavailable', canApply: false }), /Docker.*installation/);
assert.match(card({ ...status, method: 'unavailable', canApply: false }), /Native installation/);
assert.doesNotMatch(card({ ...status, target: null, updateAvailable: false, canApply: false, error: 'Release check unavailable.' }), /up to date/i);
assert.doesNotMatch(card(status, { observingRequest: true }), /Updated to/);
const operation = { id: 'op-1', phase: 'completed' as const, targetRevision, targetVersion: '0.22.0', startedAt: 1, updatedAt: 2, message: 'Complete' };
assert.doesNotMatch(card({ ...status, operation }), /Updated to Hermes/);
assert.match(card({ ...status, current: { ...status.current, revision: targetRevision, version: '0.22.0' }, operation }), /Updated to Hermes v0\.22\.0/);
const confirm = renderToStaticMarkup(createElement(HermesUpdateConfirmDialog, {
  target: { revision: targetRevision, version: '0.22.0', olympusVersion: '0.7.24', currentVersion: '0.21.0', method: 'dokploy' },
  applying: false, stale: false, error: null, onConfirm() {}, onCancel() {},
}));
assert.match(confirm, /Olympus v0\.7\.24/);
assert.match(confirm, /paired/i);
assert.match(confirm, /current work/i);


const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function harness(environment: Record<string, unknown> = {}) {
  const dependency = createRequire(file), slots: any[] = [], effects: Array<() => void> = [], cleanups = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let cursor = 0, timerId = 0;
  const hooks: any = { ...dependency('react'), useState(initial: any) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }]; },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial }; }, useCallback: (fn: any) => fn,
    useEffect(fn: () => void | (() => void), deps: unknown[]) { const at = cursor++; const prior = slots[at]; if (!prior || deps.some((value, i) => value !== prior[i])) { slots[at] = deps; effects.push(() => { cleanups.get(at)?.(); const cleanup = fn(); if (cleanup) cleanups.set(at, cleanup); else cleanups.delete(at); }); } } };
  // Keep callback identity stable like React so effects run only when their inputs change.
  hooks.useCallback = (fn: any, deps: unknown[]) => { const at = cursor++; const previous = slots[at]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[at] = { fn, deps }; return slots[at].fn; };
  hooks.useLayoutEffect = hooks.useEffect;
  const exports: any = {};
  runInNewContext(code, { exports, console, ...environment, window: { setTimeout(fn: () => void) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id: number) { timers.delete(id); } }, require: (name: string) => name === 'react' ? hooks : dependency(name) });
  const render = (name = 'HermesUpdateSettings', props?: any, beforeEffects?: (tree: any) => void) => { cursor = 0; const tree = exports[name](props); beforeEffects?.(tree); for (const effect of effects.splice(0)) effect(); return tree; };
  return { render, timers, advance() { const next = timers.entries().next().value; assert.ok(next, 'expected a status observation timer'); timers.delete(next[0]); next[1](); }, unmount() { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); } };
}
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
globalThis.fetch = (url, init) => new Promise((resolve, reject) => calls.push({ url: String(url), init, resolve, reject }));
const respond = async (index: number, body: unknown, httpStatus = 200) => { calls[index].resolve(Response.json(body, { status: httpStatus })); await flush(); };
const cardProps = (tree: any) => tree.props.children[0].props;
const modalProps = (tree: any) => tree.props.children[1]?.props;
try {
  const h = harness(); h.render();
  assert.equal(calls[0].url, '/api/updates/hermes');
  await respond(0, status);
  cardProps(h.render()).onRequestUpdate();
  const firstConfirmation = modalProps(h.render());
  assert.equal(calls.length, 1, 'opening confirmation cannot start an update');
  firstConfirmation.onConfirm(); firstConfirmation.onConfirm();
  assert.equal(calls.length, 2, 'rapid duplicate confirmations launch one request');
  assert.equal(calls[1].url, '/api/updates/hermes/apply');
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(new Headers(calls[1].init?.headers).get('X-Olympus-Update'), '1');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { targetRevision, targetOlympusVersion: '0.7.24' });
  await respond(1, { accepted: true, operationId: 'op-1' }, 202);
  let tree = h.render();
  assert.equal(modalProps(tree), undefined);
  assert.equal(cardProps(tree).observingRequest, true, 'acceptance alone is not completion');
  await respond(2, { ...status, canApply: false, operation: { ...operation, phase: 'installing' } });
  tree = h.render(); assert.equal(h.timers.size, 1);
  h.advance(); calls[3].reject(new Error('synthetic disconnect')); await flush();
  tree = h.render(); assert.ok(cardProps(tree).error); assert.equal(h.timers.size, 1);
  h.advance(); calls[4].reject(new Error('same disconnect')); await flush();
  h.render(); assert.equal(h.timers.size, 1, 'repeated identical disconnects continue observation without an elapsed-time cap');
  h.advance(); await respond(5, { ...status, canApply: false, operation });
  tree = h.render(); assert.equal(h.timers.size, 1, 'host completion with wrong running revision continues observation');
  h.advance(); await respond(6, { ...status, canApply: false, current: { ...status.current, revision: targetRevision, version: '0.22.0' }, operation });
  tree = h.render(); assert.equal(h.timers.size, 0, 'only verified terminal state stops observation');
  assert.match(card(cardProps(tree).status), /Updated to Hermes/);
  h.unmount();

  const stale = harness(); const start = calls.length; stale.render(); await respond(start, status);
  cardProps(stale.render()).onRequestUpdate(); stale.render();
  cardProps(stale.render()).onRefresh(); const older = calls.length - 1;
  cardProps(stale.render()).onRefresh(); const newer = calls.length - 1;
  assert.equal(calls[newer].url, '/api/updates/hermes?refresh=true');
  const changed = { ...status, target: { ...status.target!, revision: 'c'.repeat(40) } };
  await respond(newer, changed); stale.render(); await respond(older, status);
  const staleTree = stale.render(); assert.equal(cardProps(staleTree).status.target.revision, changed.target.revision, 'late older checks cannot replace the current target');
  assert.equal(modalProps(staleTree).stale, true);
  const beforeConfirm = calls.length; modalProps(staleTree).onConfirm();
  assert.equal(calls.length, beforeConfirm, 'stale confirmation cannot submit a different target'); stale.unmount();

  const remount = harness(); const remountRequest = calls.length; remount.render();
  await respond(remountRequest, { ...status, canApply: false, operation: { ...operation, phase: 'draining' } }); remount.render();
  assert.equal(remount.timers.size, 1, 'returning to Settings resumes the durable active operation'); remount.unmount();

  const uncertain = harness(); const uncertainStart = calls.length; uncertain.render(); await respond(uncertainStart, status);
  cardProps(uncertain.render()).onRequestUpdate(); modalProps(uncertain.render()).onConfirm();
  calls[uncertainStart + 1].reject(new Error('lost apply response')); await flush();
  await respond(uncertainStart + 2, status);
  const uncertainTree = uncertain.render(); assert.equal(cardProps(uncertainTree).observingRequest, true);
  const beforeRetry = calls.length; cardProps(uncertainTree).onRequestUpdate(); uncertain.render();
  assert.equal(calls.length, beforeRetry); assert.equal(uncertain.timers.size, 1, 'unknown request outcome is observed instead of retried'); uncertain.unmount();
} finally { globalThis.fetch = originalFetch; }


const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const events = new Map<string, Set<(event: any) => void>>();
const doc: any = { activeElement: null, addEventListener(type: string, listener: (event: any) => void) { if (!events.has(type)) events.set(type, new Set()); events.get(type)!.add(listener); }, removeEventListener(type: string, listener: (event: any) => void) { events.get(type)?.delete(listener); } };
const control = (name: string): any => ({ name, disabled: false, isConnected: true, focus() { doc.activeElement = this; for (const listener of events.get('focusin') ?? []) listener({ target: this }); } });
const trigger = control('update trigger'), cancel = control('cancel'), confirmButton = control('confirm');
const dialogNode = Object.assign(control('dialog'), { contains(target: any) { return [this, cancel, confirmButton].includes(target); }, querySelectorAll() { return [cancel, confirmButton].filter(button => !button.disabled); } });
trigger.focus();
let cancelled = 0;
const focusHarness = harness({ document: doc });
const props = { target: { revision: targetRevision, version: '0.22.0', olympusVersion: '0.7.24', currentVersion: '0.21.0', method: 'native' }, applying: false, stale: false, error: null, onConfirm() {}, onCancel() { cancelled++; } };
const renderFocus = () => focusHarness.render('HermesUpdateConfirmDialog', props, tree => {
  for (const node of nodes(tree)) if (node.props.ref) node.props.ref.current = node.props.role === 'dialog' ? dialogNode : cancel;
});
renderFocus(); assert.equal(doc.activeElement, cancel, 'confirmation starts with focus on safe Cancel action');
const key = (name: string, shiftKey = false) => { let prevented = false; for (const listener of events.get('keydown') ?? []) listener({ key: name, shiftKey, preventDefault() { prevented = true; }, stopPropagation() {} }); assert.ok(prevented); };
key('Tab', true); assert.equal(doc.activeElement, confirmButton, 'reverse Tab stays inside dialog');
key('Tab'); assert.equal(doc.activeElement, cancel, 'forward Tab wraps inside dialog');
trigger.focus(); assert.equal(doc.activeElement, cancel, 'outside focus is contained while confirmation is open');
key('Escape'); assert.equal(cancelled, 1);
props.applying = true; cancel.disabled = true; confirmButton.disabled = true; renderFocus();
key('Escape'); assert.equal(cancelled, 1, 'Escape cannot close an in-flight update request');
key('Tab'); assert.equal(doc.activeElement, dialogNode, 'busy confirmation retains focus when its controls are disabled');
focusHarness.unmount(); assert.equal(doc.activeElement, trigger, 'closing restores the original update trigger');
assert.equal(events.get('keydown')?.size, 0);
for (const phase of ['failed', 'rolled_back', 'interrupted'] as const) {
  assert.doesNotMatch(card({ ...status, operation: { ...operation, phase, message: 'Check setup and recovery.' } }), /Updated to Hermes/);
}
console.log('Hermes update Settings tests passed');
