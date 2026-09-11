import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { StudioGitHubInstallation } from '../shared/types.js';
import { ProjectGitHubAccessView } from '../client/src/components/ProjectGitHubAccess.js';
import { fetchProjectGitHubAccess, saveProjectGitHubAccess } from '../client/src/lib/api.js';

const accounts: StudioGitHubInstallation[] = [
  { id: 11, accountLogin: 'destination', label: 'Main account', accountType: 'Organization', permissionMode: 'read_write', createdAt: 1, updatedAt: 1 },
  { id: 22, accountLogin: 'sources', label: 'Source library', accountType: 'User', permissionMode: 'upgrade_required', createdAt: 1, updatedAt: 1 },
];
const defaults = { accounts, installationIds: [22], loading: false, saving: false, dirty: false, canManage: true, disabled: false, error: null, saved: false, onToggle() {}, onSave() {}, onRetry() {} };
const render = (props: Partial<typeof defaults> = {}) => renderToStaticMarkup(createElement(MemoryRouter, null,
  createElement(ProjectGitHubAccessView, { ...defaults, ...props }),
));
const checkbox = (html: string, id: number) => html.match(new RegExp(`<input[^>]*value="${id}"[^>]*>`))?.[0] ?? '';
const saveButton = (html: string) => html.match(/<button[^>]*>Save GitHub access<\/button>/)?.[0] ?? '';
const selected = render();
assert.match(selected, /Source library/);
assert.match(selected, /@sources/);
assert.match(checkbox(selected, 22), /checked=""/, 'read-only connections remain selectable and saved grants stay checked');
assert.doesNotMatch(checkbox(selected, 11), /checked=""/, 'main connection must not gain implicit source access');
assert.doesNotMatch(render({ installationIds: [] }), /checked=""/, 'fresh Projects have no selected source accounts');
assert.match(saveButton(selected), /disabled=""/, 'unchanged selection cannot be saved');
assert.doesNotMatch(saveButton(render({ dirty: true })), /disabled=""/);
assert.match(checkbox(render({ canManage: false, dirty: true }), 22), /disabled=""/);
assert.match(saveButton(render({ canManage: false, dirty: true })), /disabled=""/);
assert.match(render({ loading: true }), /Loading GitHub accounts/);
assert.match(render({ saving: true, dirty: true }), /Checking and saving/);
assert.match(render({ accounts: [], installationIds: [] }), /No GitHub accounts connected/);
assert.match(render({ error: 'Source account is no longer connected.' }), /role="alert"[^>]*>Source account is no longer connected/);
assert.match(selected, /read-only/);
assert.match(selected, /main repository remains the publish destination/);
assert.match(render({ saved: true }), /GitHub access saved/);

const previousFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/projects/project%2Fone/github-access?profile=default');
    if (init?.method === 'PUT') assert.deepEqual(JSON.parse(String(init.body)), { installationIds: [22] });
    return Response.json({ installationIds: [22], accounts });
  };
  assert.deepEqual(await fetchProjectGitHubAccess('project/one'), { installationIds: [22], accounts });
  assert.deepEqual(await saveProjectGitHubAccess('project/one', [22]), { installationIds: [22], accounts });
  globalThis.fetch = async () => Response.json({ error: 'Source account is no longer connected.' }, { status: 409 });
  await assert.rejects(saveProjectGitHubAccess('project/one', [22]), /Source account is no longer connected/);
} finally { globalThis.fetch = previousFetch; }
console.log('Project GitHub access UI and API tests passed');
