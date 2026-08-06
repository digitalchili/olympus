import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateStatus } from '../shared/types.js';
import { applyUpdate, fetchUpdateStatus } from '../client/src/lib/api.js';
import { UpdateConfirmDialog, UpdateSettingsCard } from '../client/src/components/UpdateSettings.js';

const availableUpdate: UpdateStatus = {
  currentVersion: '1.2.3',
  latestVersion: '1.3.0',
  updateAvailable: true,
  updateConfigured: true,
  releaseUrl: 'https://github.com/example/project/releases/tag/v1.3.0',
  checkedAt: Date.now(),
};

const configuredMarkup = renderToStaticMarkup(createElement(UpdateSettingsCard, {
  status: availableUpdate,
  loading: false,
  applying: false,
  accepted: false,
  error: null,
  onRefresh() {},
  onRequestUpdate() {},
}));
assert.match(configuredMarkup, /Current/);
assert.match(configuredMarkup, /v1\.2\.3/);
assert.match(configuredMarkup, /Latest/);
assert.match(configuredMarkup, /v1\.3\.0/);
assert.match(configuredMarkup, /href="https:\/\/github\.com\/example\/project\/releases\/tag\/v1\.3\.0"/);
assert.match(configuredMarkup, /Release notes/);
assert.match(configuredMarkup, /data-update-action="true"/);
assert.doesNotMatch(configuredMarkup, /data-update-action="true"[^>]* disabled=""/);

const unconfiguredMarkup = renderToStaticMarkup(createElement(UpdateSettingsCard, {
  status: { ...availableUpdate, updateConfigured: false },
  loading: false,
  applying: false,
  accepted: false,
  error: null,
  onRefresh() {},
  onRequestUpdate() {},
}));
assert.match(unconfiguredMarkup, /installation-local update hook/);
assert.match(unconfiguredMarkup, /unavailable/i);
assert.match(unconfiguredMarkup, /data-update-action="true"[^>]* disabled=""/);

const dialogMarkup = renderToStaticMarkup(createElement(UpdateConfirmDialog, {
  currentVersion: '1.2.3',
  latestVersion: '1.3.0',
  applying: false,
  error: null,
  onConfirm() {},
  onCancel() {},
}));
assert.match(dialogMarkup, /role="dialog"/);
assert.match(dialogMarkup, /aria-modal="true"/);
assert.match(dialogMarkup, /Update this installation\?/);
assert.match(dialogMarkup, /v1\.2\.3/);
assert.match(dialogMarkup, /v1\.3\.0/);
assert.match(dialogMarkup, /Update now/);

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string }> = [];
globalThis.fetch = async (input, init) => {
  calls.push({ url: String(input), method: init?.method ?? 'GET' });
  return new Response(JSON.stringify(calls.length === 1 ? availableUpdate : { accepted: true }), {
    status: calls.length === 1 ? 200 : 202,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  assert.deepEqual(await fetchUpdateStatus(true), availableUpdate);
  assert.deepEqual(await applyUpdate(), { accepted: true });
  assert.deepEqual(calls, [
    { url: '/api/updates?refresh=true', method: 'GET' },
    { url: '/api/updates/apply', method: 'POST' },
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

const settingsSource = await readFile('client/src/components/SettingsPage.tsx', 'utf8');
assert.match(settingsSource, /import \{ UpdateSettings \} from ['"]\.\/UpdateSettings['"]/);
assert.match(settingsSource, /<UpdateSettings \/>/);

console.log('Update settings tests passed');
