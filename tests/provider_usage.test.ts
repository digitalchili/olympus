import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderUsageCard } from '../client/src/components/UsageSettings.js';
import { createAgentRouter } from '../server/routes/agent.js';
import type { ProviderUsage } from '../shared/provider-usage.js';

const usage: ProviderUsage = { provider: 'openai-codex', label: 'OpenAI', isDefault: true, available: true,
  plan: 'Pro', windows: [{ label: 'Current window', remainingPercent: 0, resetAt: 120000, detail: null },
    { label: 'Weekly', remainingPercent: null, resetAt: null, detail: null }],
  details: [], unavailableReason: null, dashboardUrl: 'https://chatgpt.com/codex/settings/usage', fetchedAt: 1000 };
const html = renderToStaticMarkup(createElement(ProviderUsageCard, { usage, now: 0 }));
assert.match(html, /0% remaining/);
assert.match(html, /aria-valuenow="0"/);
assert.match(html, /Resets in 2m/);
assert.match(html, /Unavailable/);
assert.equal((html.match(/role="progressbar"/g) ?? []).length, 1, 'unknown allowance is never drawn as zero');

let received: unknown[] = [];
const router = createAgentRouter({ getUsage: async (...args) => { received = args; return { providers: [usage] }; } } as never);
const route = router.stack.find(layer => layer.route?.path === '/usage')!.route!.stack[0].handle;
let body: unknown;
let status = 200;
const response = { set: () => response, json: (value: unknown) => { body = value; }, status: (value: number) => { status = value; return response; } };
// Profile middleware has already resolved the selected profile on the request.
const { requestProfile } = await import('../server/profile-context.js');
// Exercise through the resolver's documented request property below.
const request = { query: { profile: 'default', refresh: 'true' } };
const expectedProfile = requestProfile(request as never).id;
await route(request as never, response as never, () => {});
assert.equal(status, 200);
assert.deepEqual(received, [expectedProfile, true]);
assert.deepEqual(body, { providers: [usage] });
await route({ query: {}, activeHermesProfile: { id: 'som' } } as never, response as never, () => {});
assert.deepEqual(received, ['som', false], 'usage goes to the resolved profile rather than the default account');
const failing = createAgentRouter({ getUsage: async () => { throw new Error('Bearer do-not-expose'); } } as never);
await failing.stack.find(layer => layer.route?.path === '/usage')!.route!.stack[0].handle(request as never, response as never, () => {});
assert.equal(status, 503);
assert.doesNotMatch(JSON.stringify(body), /do-not-expose/);
console.log('Provider usage UI and route tests passed');
