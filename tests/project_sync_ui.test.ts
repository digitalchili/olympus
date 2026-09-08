import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ProjectSyncState } from '../shared/types.js';
import { ProjectGitHubSyncView } from '../client/src/components/ProjectGitHubSync.js';
import { ApiError, syncProjectFromGitHub } from '../client/src/lib/api.js';

const render = (state: ProjectSyncState, pending = false, error: string | null = null) => renderToStaticMarkup(createElement(MemoryRouter, null,
  createElement(ProjectGitHubSyncView, { projectId: 'project-1', state, pending, disabled: false, error, onSync() {}, onRelease() {} }),
));
assert.match(render({ lastSync: null, blocker: null }), /Sync latest from GitHub/);
assert.match(render({ lastSync: null, blocker: null }), /Not synced yet/);
assert.doesNotMatch(render({ lastSync: null, blocker: null }), /Up to date/);
const lastSync = { verifiedAt: Date.UTC(2026, 8, 8, 6), currentSha: 'a'.repeat(40), updated: true };
const updated = render({ lastSync, blocker: null });
assert.match(updated, /Updated/);
assert.match(updated, /Last verified/);
assert.match(updated, /datetime="2026-09-08T06:00:00.000Z"/i);
assert.match(updated, /aaaaaaa/);
assert.match(render({ lastSync: { ...lastSync, updated: false }, blocker: null }), /Up to date/);
const blocker = { kind: 'editor' as const, task: { id: 'task-1', title: 'Website update', profileId: 'writer' }, message: 'This idle task still holds the Project editor.', releaseEditorLeaseId: 'lease-1' };
const idle = render({ lastSync, blocker });
assert.match(idle, /Release editor and sync/);
assert.match(idle, /Website update/);
assert.match(idle, /\/projects\/project-1\/tasks\/task-1\?profile=writer/);
const active = render({ lastSync, blocker: { ...blocker, kind: 'active_task', releaseEditorLeaseId: null, message: 'Wait for this task to finish.' } });
assert.doesNotMatch(active, /Release editor and sync/);
assert.match(active, /Website update/);
assert.match(render({ lastSync, blocker }, true), /disabled=""/);
assert.match(render({ lastSync, blocker }, true), /Syncing/);
assert.match(render({ lastSync, blocker: null }, false, 'GitHub could not be reached'), /GitHub could not be reached/);

const previousFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/projects/project-1/sync', 'Project API retains operator routing, without ambient profile credentials');
    assert.deepEqual(JSON.parse(String(init?.body)), { releaseEditorLeaseId: 'lease-1' });
    return new Response(JSON.stringify({ error: blocker.message, code: 'PROJECT_SYNC_BLOCKED', blocker }), { status: 409, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(syncProjectFromGitHub('project-1', 'lease-1'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual(error.details?.blocker, blocker, 'API errors preserve the task and safe recovery action');
    return true;
  });
} finally { globalThis.fetch = previousFetch; }
console.log('Project sync UI and API regression tests passed');
