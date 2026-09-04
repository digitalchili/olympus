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
assert.match(direct, /Model:/);
assert.doesNotMatch(direct, /Requested:/);
