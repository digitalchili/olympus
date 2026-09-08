import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicProjectEditorLease } from '../shared/types.js';
import * as api from '../client/src/lib/api.js';
import * as selection from '../client/src/lib/projectCodeSelection.js';
import { ProjectTaskSelector } from '../client/src/components/ProjectTaskSelector.js';

const tasks = [
  { id: 'task-a', title: 'Saved design changes', status: 'in_progress' as const },
  { id: 'task-b', title: 'Create poster', status: 'in_progress' as const },
];
const editors: PublicProjectEditorLease[] = tasks.map((task, index) => ({
  id: `lease-${index}`, projectId: 'project-one', taskId: task.id, profileId: 'default',
  repositoryFullName: 'team/site', baseBranch: 'main', branchName: `olympus/${task.id}`,
  baseSha: 'a'.repeat(40), status: 'active', createdAt: index, updatedAt: index, releasedAt: null,
}));
const { selectProjectCodeTask } = selection;
assert.equal(selectProjectCodeTask('', tasks, editors), 'task-a', 'existing saved work remains discoverable on the Code tab');
assert.equal(selectProjectCodeTask('task-b', tasks, editors), 'task-b', 'refreshing does not replace the selected task with another editor');
assert.equal(selectProjectCodeTask('task-b', tasks, [editors[0]!]), 'task-b', 'a task remains selected after its lease is released');
assert.equal(selectProjectCodeTask('deleted', tasks, editors), 'task-a', 'a deleted selection falls back to a present task');
assert.equal(selectProjectCodeTask('task-b', [], []), '', 'leaving a Project does not retain a stale task');
assert.equal(typeof selection.projectTaskCodeView, 'function');
const versions = [{ id: 'version-b', taskId: 'task-b' }, { id: 'version-a', taskId: 'task-a' }];
const statusA = { taskId: 'task-a', clean: false, changedFiles: ['design.tsx'] };
const viewB = selection.projectTaskCodeView('task-b', editors, versions, statusA);
assert.equal(viewB.editor?.taskId, 'task-b');
assert.equal(viewB.status, null, 'a late status response for task A cannot enable publishing task B');
assert.deepEqual(viewB.versions, [{ id: 'version-b', taskId: 'task-b' }], 'restore history never mixes another task branch');
const viewA = selection.projectTaskCodeView('task-a', editors, versions, statusA);
assert.equal(viewA.status, statusA);
assert.deepEqual(viewA.versions, [{ id: 'version-a', taskId: 'task-a' }]);

for (const selectedTaskId of ['task-a', 'task-b']) {
  const html = renderToStaticMarkup(createElement(ProjectTaskSelector, { tasks, selectedTaskId, disabled: false, onSelect() {} }));
  assert.match(html, /Saved design changes/);
  assert.match(html, /Create poster/);
  assert.match(html, new RegExp(`<option value="${selectedTaskId}" selected="">`), 'each task can be selected even when another task owns saved work');
}
const releaseHtml = (canRelease: boolean) => renderToStaticMarkup(createElement(ProjectTaskSelector, {
  tasks, selectedTaskId: 'task-b', disabled: false, canRelease, onSelect() {}, onRelease() {},
}));
assert.match(releaseHtml(true), /<button[^>]*>Release workspace<\/button>/, 'a clean selected task can release its workspace without deleting files');
assert.doesNotMatch(releaseHtml(true), /<button[^>]* disabled=""/);
assert.match(releaseHtml(false), /<button[^>]* disabled=""/, 'dirty task work cannot be released');

const previousFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    assert.ok(!path.includes('profile='), 'Project operations preserve operator routing');
    if (path === '/api/projects/project-one/editors') return Response.json({ editors });
    for (const [index, task] of tasks.entries()) {
      if (path === `/api/projects/project-one/editor?taskId=${task.id}`) return Response.json({ editor: editors[index] });
      if (path === `/api/projects/project-one/editor/status?taskId=${task.id}`) return Response.json({ status: { clean: false, changedFiles: [`${task.id}.txt`], summary: task.title, diff: `+${task.title}` } });
      if (path === '/api/projects/project-one/editor/prepare' || path === '/api/projects/project-one/commit-push') {
        const body = JSON.parse(String(init?.body));
        if (body.taskId === task.id) return Response.json(path.endsWith('/prepare') ? { editor: editors[index] } : { version: { taskId: task.id }, versions: [] });
      }
    }
    assert.fail(`Unexpected request: ${path}`);
  };
  for (const task of tasks) {
    assert.equal((await api.fetchProjectEditor('project-one', task.id)).editor?.taskId, task.id, 'task status must never inspect a different active editor');
    assert.deepEqual((await api.fetchProjectEditorStatus('project-one', task.id)).status.changedFiles, [`${task.id}.txt`]);
    assert.equal((await api.prepareProjectEditor('project-one', task.id)).editor.taskId, task.id);
    assert.equal((await api.commitPushProject('project-one', task.id, 'Save changes')).version.taskId, task.id);
  }
  assert.equal((await api.fetchProjectEditors('project-one')).editors.length, 2);
} finally { globalThis.fetch = previousFetch; }
console.log('Project task selection and API isolation tests passed');
