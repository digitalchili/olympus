import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import * as recovery from '../client/src/lib/chatSendRecovery.js';
import { ProjectChatBlockedNotice } from '../client/src/components/ProjectChatBlockedNotice.js';

const body = {
  error: 'Earlier design has saved changes. Finish that task before starting another.',
  code: 'PROJECT_REPOSITORY_BUSY', activeTaskId: 'prior/task', activeTaskTitle: 'Earlier design', activeTaskProfileId: 'som chai', reason: 'changes',
};
const failed = recovery.chatSendFailure(423, body);
assert.deepEqual(failed, { ok: false, conflict: false, ...body }, 'admission failures retain the owner and cause required for recovery');
assert.equal(recovery.chatSendFailure(503, null).error, 'HTTP 503');
assert.equal(recovery.chatSendFailure(409, { code: 'TASK_RUN_ACTIVE' }).conflict, true);

const blocker = recovery.settleProjectChatBlocker(null, 'new-task', 'new-task', failed);
assert.ok(blocker);
assert.equal(recovery.settleProjectChatBlocker(blocker, 'new-task', 'new-task', { ok: true }), null, 'an accepted retry clears the stale blocker');
assert.equal(recovery.settleProjectChatBlocker(null, 'other-task', 'new-task', failed), null, 'late rejection after navigation cannot block another task');
assert.equal(recovery.settleProjectChatBlocker(blocker, 'new-task', 'old-task', { ok: true }), blocker, 'a stale accepted response cannot dismiss the current blocker');

const sentContent = 'Create a poster\n\n[Attached files:\n- /workspace/reference.png]';
const draft = { currentTaskId: 'new-task', responseTaskId: 'new-task', revisionAtSend: 1, currentRevision: 1, currentDraft: '', sentContent };
assert.equal(recovery.restoreRejectedChatDraft(draft), sentContent, 'the rejected initial message and uploaded paths return to the composer');
assert.equal(recovery.restoreRejectedChatDraft({ ...draft, currentTaskId: 'other-task' }), '', 'a task switch never restores the old message in the new composer');
assert.equal(recovery.restoreRejectedChatDraft({ ...draft, currentDraft: 'A newer draft', currentRevision: 2 }), 'A newer draft', 'a slow rejected send cannot overwrite later typing');
assert.equal(recovery.restoreRejectedChatDraft({ ...draft, currentRevision: 3 }), '', 'typing and then clearing the composer is still a later edit');

const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectChatBlockedNotice, {
  projectId: 'project/one', profileId: 'default', blocker: blocker!,
})));
assert.match(html, /role="alert"/);
assert.match(html, /Earlier design/);
assert.match(html, /Open previous task/);
assert.match(html, /href="\/projects\/project%2Fone\/tasks\/prior%2Ftask\?profile=som\+chai"/);
assert.match(html, /Manage Project/);
assert.match(html, /href="\/projects\/project%2Fone\?profile=default"/);
const recoveryLinks = html.match(/<a\b[^>]*>/g) ?? [];
assert.equal(recoveryLinks.length, 2);
assert.ok(recoveryLinks.every(link => /target="_blank"/.test(link) && /rel="noopener noreferrer"/.test(link)), 'recovery opens separately so navigating cannot discard the unsent draft');
assert.doesNotMatch(html, /<button/, 'the blocker provides navigation, never an unsafe direct release');
const legacyHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectChatBlockedNotice, {
  projectId: 'project', profileId: 'som', blocker: { ...blocker!, activeTaskProfileId: undefined },
})));
assert.match(legacyHtml, /href="\/projects\/project\/tasks\/prior%2Ftask\?profile=som"/, 'older servers still link within the active profile');
assert.equal(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectChatBlockedNotice, { projectId: 'project', profileId: 'default', blocker: null }))), '');
console.log('Project chat recovery tests passed');
