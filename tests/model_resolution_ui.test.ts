import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunModelResolution } from '../client/src/components/RunModelResolution.js';

const fallbackReason = 'Primary model failed; Hermes activated its configured fallback.';
const fallback = renderToStaticMarkup(createElement(RunModelResolution, {
  resolution: {
    requested: { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' },
    actual: { provider: 'openai-codex', model: 'gpt-5.5', reasoningEffort: 'high' },
    fallbackReason,
  },
}));
assert.match(fallback, /Requested:/);
assert.match(fallback, /openai-codex:gpt-6-astra \(xhigh\)/);
assert.match(fallback, /Actual:/);
assert.match(fallback, /openai-codex:gpt-5\.5 \(high\)/);
assert.ok(fallback.includes(fallbackReason));

const direct = renderToStaticMarkup(createElement(RunModelResolution, {
  resolution: {
    requested: { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    actual: { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    fallbackReason: null,
  },
}));
assert.equal(direct, '', 'the selected model should not be repeated in a separate status panel');

const requested = { model: 'gpt-6-astra', provider: 'openai-codex', reasoningEffort: 'xhigh' };
const legacyReason = 'Primary model failed; Hermes activated its configured fallback.';
function render(actual = requested, fallbackReason?: string) {
  return renderToStaticMarkup(createElement(RunModelResolution, { resolution: { requested, actual, fallbackReason } }));
}
assert.equal(render(), '');
assert.equal(render(requested, legacyReason), '', 'old identical-model notices must not repeat the false switch claim');
const sameEffortFallback = render({ ...requested, model: 'gpt-5.5' }, legacyReason);
assert.match(sameEffortFallback, /Actual:/);
assert.match(sameEffortFallback, /gpt-5.5/);
assert.match(sameEffortFallback, /configured fallback/);
assert.match(render({ ...requested, provider: 'openrouter' }, legacyReason), /configured fallback/);
assert.match(render({ ...requested, reasoningEffort: 'high' }), /Actual:/);
assert.match(render(requested, 'A different diagnostic'), /A different diagnostic/);
console.log('Model resolution display tests passed');
