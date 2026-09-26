import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { OpenAIAuthResponse } from '../shared/openai-auth.js';
import { deriveRunFailureNotice } from '../client/src/lib/runFailurePresentation.js';
import { RunFailureBanner } from '../client/src/components/RunFailureBanner.js';
import type { OpenAIAuthSettings } from '../client/src/components/OpenAIAuthSettings.js';

const failed = { runId: 'run-1', taskId: 'task-1', kind: 'chat', status: 'error', startedAt: 1,
  updatedAt: 2, completedAt: 2, modelResolution: null, errorCode: 'openai_auth_required' } as const;
const notice = deriveRunFailureNotice(failed)!;
assert.equal(notice.action, 'reconnect_openai', 'persisted OpenAI auth failure offers login instead of repeating the task');
assert.equal(deriveRunFailureNotice({ ...failed, errorCode: 'openai_auth_unavailable' })?.action, 'check_openai');
assert.equal(deriveRunFailureNotice({ ...failed, errorCode: 'auth_error' })?.action, undefined, 'other providers must not open OpenAI login');
assert.equal(deriveRunFailureNotice({ ...failed, errorCode: null, error: '[openai_auth_required] upstream text' })?.action, undefined, 'raw provider prose cannot authorize an OpenAI action');
assert.equal(deriveRunFailureNotice({ ...failed, status: 'stopped' })?.action, undefined, 'Stop keeps its deliberate stopped state');
const banner = renderToStaticMarkup(createElement(RunFailureBanner, { notice, onOpenAIAuth: () => {}, onContinue: () => {} }));
assert.match(banner, /Reconnect OpenAI/);
assert.doesNotMatch(banner, /Continue task/);
assert.match(renderToStaticMarkup(createElement(RunFailureBanner, { notice, authReady: true, onContinue: () => {} })), /Continue task/);
assert.doesNotMatch(renderToStaticMarkup(createElement(RunFailureBanner, { notice, busy: true, onOpenAIAuth: () => {} })), /disabled=""/, 'a missing model or slow model configuration must not block native sign-in');

const file = new URL('../client/src/components/OpenAIAuthSettings.tsx', import.meta.url);
const dependency = createRequire(file);
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const unknown: OpenAIAuthResponse = { status: { provider: 'openai-codex', state: 'unknown', checkedAt: null, credentialScope: 'unknown', code: null }, session: null };
const waiting: OpenAIAuthResponse = { ...unknown, session: { sessionId: 'login-1', state: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: Date.now() + 600_000, pollIntervalMs: 1000, code: null } };
const saved: OpenAIAuthResponse = { status: { ...unknown.status, state: 'saved_login_ready', credentialScope: 'shared_default', checkedAt: 100 }, session: { ...waiting.session!, state: 'saved', userCode: null, verificationUrl: null } };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Run the production component and API helper. Only React scheduling, timers and HTTP are controlled.
function harness(initialProps: Parameters<typeof OpenAIAuthSettings>[0] = { profileId: 'som', profileLabel: 'Som' }) {
  const slots: any[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  const requests: Array<{ url: string; init?: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let ready = 0;
  let isReady = false;
  let props = initialProps;
  globalThis.fetch = (input, init) => new Promise<Response>((resolve, reject) => requests.push({ url: String(input), init, resolve, reject }));
  const exports: any = {};
  runInNewContext(code, {
    exports, require: (name: string) => name === 'react' ? {
      useState: (initial: any) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
      },
      useRef: (initial: unknown) => { const index = cursor++; return slots[index] ??= { current: initial }; },
      useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
        const index = cursor++;
        const previous = slots[index];
        if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) effects.push(() => {
          previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() };
        });
      },
    } : dependency(name),
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    navigator: { clipboard: { writeText: async () => {} } },
    console,
  });
  let tree: ReactNode;
  const render = () => {
    cursor = 0; tree = exports.OpenAIAuthSettings({ ...props, onReady: () => { ready++; isReady = true; }, onNotReady: () => { isReady = false; } });
    while (effects.length) effects.shift()!();
    return renderToStaticMarkup(tree);
  };
  const nodes = (node: ReactNode): ReactElement<any>[] => {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...nodes(element.props.children)];
  };
  return {
    render, requests, timers, ready: () => ready, isReady: () => isReady,
    click(label: string) {
      render();
      const button = nodes(tree).find(node => node.type === 'button' && renderToStaticMarkup(node).includes(label));
      assert.ok(button, `Missing button: ${label}`);
      assert.ok(!button.props.disabled, `Disabled button: ${label}`);
      button.props.onClick();
    },
    chooseScope(value: string) {
      render();
      const select = nodes(tree).find(node => node.type === 'select');
      assert.ok(select, 'Missing scope selector');
      assert.ok(!select.props.disabled, 'Scope selector is disabled');
      select.props.onChange({ target: { value } });
      render();
    },
    async respond(index: number, body: OpenAIAuthResponse) { requests[index].resolve(Response.json(body)); await flush(); return render(); },
    async reject(index: number) { requests[index].reject(new Error('SECRET_UPSTREAM_ERROR')); await flush(); return render(); },
    tick() { const first = timers.entries().next().value; assert.ok(first); timers.delete(first[0]); first[1](); },
    change(next: typeof props) { props = next; return render(); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

const originalFetch = globalThis.fetch;
try {
  const h = harness();
  h.render();
  assert.equal(h.requests[0].url, '/api/agent/openai-auth?scope=shared&profile=som');
  assert.equal(h.requests[0].init?.method, undefined, 'mount reads cached status; it must not renew credentials');
  await h.respond(0, unknown);
  assert.match(h.render(), /not checked/i);
  h.click('Check saved login');
  assert.equal(h.requests[1].url, '/api/agent/openai-auth/check?profile=som');
  assert.deepEqual(JSON.parse(String(h.requests[1].init?.body)), { scope: 'shared' });
  await h.respond(1, { ...unknown, status: { ...unknown.status, state: 'temporarily_unavailable' } });
  assert.match(h.render(), /temporarily unavailable/i);
  h.click('Sign in to OpenAI');
  assert.deepEqual(JSON.parse(String(h.requests[2].init?.body)), { scope: 'shared' });
  await h.respond(2, waiting);
  assert.match(h.render(), /https:\/\/auth.openai.com\/codex\/device/);
  assert.match(h.render(), /ABCD-EFGH/);
  assert.match(h.render(), /noopener noreferrer/);
  h.tick();
  assert.equal(h.timers.size, 0, 'a slow poll must not overlap with a second poll');
  assert.deepEqual(JSON.parse(String(h.requests[3].init?.body)), { scope: 'shared', sessionId: 'login-1' });
  await h.respond(3, { ...waiting, session: { ...waiting.session!, state: 'waiting_for_idle' } });
  assert.match(h.render(), /finish/i);
  assert.equal(h.ready(), 0, 'approval before coordinated save cannot enable Continue');
  h.tick();
  await h.respond(4, saved);
  assert.equal(h.ready(), 1);
  assert.equal(h.timers.size, 0);
  assert.doesNotMatch(h.render(), /ABCD-EFGH/);
  assert.ok(h.requests.every(request => request.url.includes('/agent/openai-auth')), 'authentication never sends a task or changes the model');
  h.unmount();

  const override = harness({ profileId: 'som', profileLabel: 'Som', initialScope: 'effective' });
  override.render();
  assert.match(override.requests[0].url, /scope=profile/);
  await override.respond(0, unknown);
  assert.match(override.requests[1].url, /\/check\?profile=som/, 'unknown scope must be resolved before proposing shared login');
  await override.respond(1, { ...unknown, status: { ...unknown.status, state: 'reconnect_required', credentialScope: 'profile' } });
  await override.respond(2, { ...unknown, status: { ...unknown.status, state: 'reconnect_required', credentialScope: 'profile' } });
  assert.throws(() => override.chooseScope('shared'), /Scope selector is disabled/, 'a task reconnect cannot switch away from its known account scope');
  override.click('Sign in to OpenAI');
  assert.deepEqual(JSON.parse(String(override.requests[3].init?.body)), { scope: 'profile' }, 'task repair preserves an explicit profile login');
  await override.respond(3, waiting);
  override.tick();
  override.click('Cancel sign-in');
  assert.match(override.requests[5].url, /\/cancel/);
  await override.respond(5, { ...unknown, session: { ...waiting.session!, state: 'cancelled' } });
  await override.respond(4, saved);
  assert.equal(override.ready(), 0, 'a late poll cannot undo a cancellation');
  assert.match(override.render(), /cancelled/i);
  override.unmount();

  const unresolved = harness({ profileId: 'som', profileLabel: 'Som', initialScope: 'effective' });
  unresolved.render();
  await unresolved.respond(0, unknown);
  await unresolved.reject(1);
  assert.match(unresolved.render(), /Choose which login/i);
  assert.doesNotMatch(unresolved.render(), /SECRET_UPSTREAM_ERROR/);
  unresolved.unmount();

  const settingsScope = harness();
  settingsScope.render(); await settingsScope.respond(0, unknown);
  settingsScope.chooseScope('profile');
  assert.equal(settingsScope.requests[1].url, '/api/agent/openai-auth?scope=profile&profile=som', 'Settings retains explicit separate-profile login choice');
  await settingsScope.respond(1, unknown); settingsScope.unmount();

  const sharedTask = harness({ profileId: 'som', profileLabel: 'Som', initialScope: 'effective' });
  sharedTask.render();
  await sharedTask.respond(0, { ...unknown, status: { ...unknown.status, credentialScope: 'shared_default' } });
  await sharedTask.respond(1, unknown); sharedTask.click('Sign in to OpenAI');
  await sharedTask.respond(2, waiting); sharedTask.tick();
  await sharedTask.respond(3, saved);
  assert.equal(sharedTask.ready(), 0, 'saving shared login cannot certify a task whose profile acquired a separate login');
  assert.equal(sharedTask.requests[4].url, '/api/agent/openai-auth/check?profile=som');
  assert.deepEqual(JSON.parse(String(sharedTask.requests[4].init?.body)), { scope: 'profile' });
  await sharedTask.respond(4, { ...unknown, status: { ...unknown.status, state: 'reconnect_required', credentialScope: 'profile' } });
  assert.equal(sharedTask.ready(), 0);
  sharedTask.unmount();

  const old = harness();
  old.render(); await old.respond(0, unknown); old.click('Sign in to OpenAI');
  old.unmount(); await old.respond(1, waiting);
  assert.equal(old.requests.length, 2, 'navigation leaves the login available for the owner to resume');
  assert.equal(old.timers.size, 0);
  assert.equal(old.ready(), 0);

  const restored = harness();
  restored.render(); await restored.respond(0, waiting);
  assert.match(restored.render(), /ABCD-EFGH/, 'a status read restores an attempt after navigation');
  restored.tick();
  restored.change({ profileId: 'other', profileLabel: 'Other' });
  assert.equal(restored.requests[2].url, '/api/agent/openai-auth?scope=shared&profile=other');
  await restored.respond(1, saved);
  assert.equal(restored.ready(), 0, 'a late old-profile poll cannot enable Continue in the new profile');
  await restored.respond(2, unknown);
  assert.doesNotMatch(restored.render(), /ABCD-EFGH/);
  restored.unmount();
  assert.ok(restored.requests.every(request => !request.url.includes('/cancel')));

  const cached = harness();
  cached.render(); await cached.respond(0, saved);
  assert.equal(cached.ready(), 0, 'a cached saved result from an earlier sign-in cannot verify a new failed run');
  cached.click('Check saved login'); await cached.respond(1, saved);
  assert.equal(cached.ready(), 1, 'an explicit current login check can enable deliberate Continue');
  cached.click('Check saved login');
  assert.equal(cached.isReady(), false, 'a new check must immediately retire the previous ready claim');
  await cached.respond(2, { ...saved, status: { ...unknown.status, state: 'temporarily_unavailable' } });
  assert.doesNotMatch(renderToStaticMarkup(createElement(RunFailureBanner, { notice, authReady: cached.isReady(), onContinue: () => {}, onOpenAIAuth: () => {} })), /Continue task/, 'failed recheck removes Continue');
  assert.doesNotMatch(cached.render(), /You can continue the task/i, 'a past saved session cannot contradict a current unavailable check');
  cached.click('Check saved login'); await cached.respond(3, saved);
  cached.chooseScope('profile');
  assert.equal(cached.isReady(), false, 'changing the login scope retires the old ready claim');
  await cached.respond(4, unknown);
  cached.click('Check saved login'); await cached.respond(5, saved);
  cached.click('Sign in to OpenAI');
  assert.equal(cached.isReady(), false, 'starting another sign-in retires the old ready claim');
  await cached.reject(6);
  assert.equal(cached.isReady(), false);
  cached.unmount();

  const uncertain = harness();
  uncertain.render(); await uncertain.respond(0, unknown); uncertain.click('Sign in to OpenAI');
  const uncertainResult: OpenAIAuthResponse = { ...unknown, session: { ...waiting.session!, state: 'failed', code: 'auth_storage_failed', userCode: null, verificationUrl: null } };
  await uncertain.respond(1, uncertainResult);
  assert.doesNotMatch(uncertain.render(), /saved login is unchanged/i, 'a storage error may occur after native credentials were written');
  assert.match(uncertain.render(), /Check saved login/i);
  assert.equal(uncertain.ready(), 0);
  uncertain.click('Check saved login');
  await uncertain.respond(2, { ...uncertainResult, status: saved.status });
  assert.equal(uncertain.ready(), 1);
  assert.doesNotMatch(uncertain.render(), /could not be confirmed/i, 'a successful check resolves the uncertain save notice');
  uncertain.unmount();

  for (const [code, message] of [['auth_account_mismatch', /same OpenAI account and workspace/i], ['auth_unsupported', /advanced.*credentials.*not supported/i]] as const) {
    const failedLogin = harness();
    failedLogin.render(); await failedLogin.respond(0, unknown); failedLogin.click('Sign in to OpenAI');
    await failedLogin.respond(1, { ...unknown, session: { ...waiting.session!, state: 'failed', code, userCode: null, verificationUrl: null } });
    assert.match(failedLogin.render(), message);
    assert.doesNotMatch(failedLogin.render(), /unchanged\. Try again/);
    failedLogin.unmount();
  }

  const unsafe = harness({ profileId: 'default', profileLabel: 'Default' });
  unsafe.render(); await unsafe.respond(0, unknown); unsafe.click('Sign in to OpenAI');
  await unsafe.respond(1, { ...waiting, session: { ...waiting.session!, verificationUrl: 'https://malicious.example/secret' } });
  assert.doesNotMatch(unsafe.render(), /malicious.example/);
  assert.doesNotMatch(unsafe.render(), /Separate login/);
  unsafe.tick(); await unsafe.respond(2, { ...unknown, session: { ...waiting.session!, state: 'expired' } });
  assert.match(unsafe.render(), /expired/i);
  assert.doesNotMatch(unsafe.render(), /ABCD-EFGH/);
  assert.equal(unsafe.timers.size, 0);
  unsafe.unmount();
} finally { globalThis.fetch = originalFetch; }
console.log('OpenAI authentication UI tests passed');
