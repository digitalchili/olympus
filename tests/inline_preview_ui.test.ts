import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskInlinePreviews } from '../client/src/components/TaskInlinePreviews.js';
import { stripPublishedPreviewManifests } from '../client/src/lib/inlinePreviews.js';
import { TASK_AGENT_SYSTEM_PROMPT } from '../server/prompts/task-agent.js';
import type { TaskAttachment } from '../shared/types.js';

const attachments: TaskAttachment[] = [
  { path: 'drafts/a.html', name: 'a.html', size: 300, preview: { id: 'a'.repeat(64), kind: 'html', title: 'Editorial', description: 'Quiet typography', groupId: 'directions-r1', groupTitle: 'Homepage directions', draftId: 'a' } },
  { path: 'drafts/b.png', name: 'b.png', size: 300, preview: { id: 'b'.repeat(64), kind: 'image', title: 'Bold', groupId: 'directions-r1', groupTitle: 'Homepage directions', draftId: 'b' } },
];
const html = renderToStaticMarkup(createElement(TaskInlinePreviews, { taskId: 'task-one', attachments, onDraftPrompt() {} }));
assert.match(html, /Homepage directions/);
assert.match(html, /Editorial/);
assert.match(html, /Bold/);
assert.match(html, /Use this direction/);
assert.match(html, /Refine this draft/);
assert.match(html, /Design concept/);
assert.match(html, /<iframe\b/);
assert.match(html, /sandbox="allow-scripts"/);
assert.doesNotMatch(html, /allow-same-origin|allow-popups|allow-top-navigation|srcdoc=/i);
assert.match(html, /referrerPolicy="no-referrer"/i);
assert.match(html, /<img[^>]+alt="Bold"/);
assert.match(html, /\/api\/tasks\/task-one\/artifacts\/preview\//);
assert.match(html, /Desktop/);
assert.match(html, /Mobile/);
assert.equal(renderToStaticMarkup(createElement(TaskInlinePreviews, { taskId: 't', attachments: [] })), '');
const manifest = '```olympus-preview\n' + JSON.stringify({ id: 'directions-r1', title: 'Homepage directions', drafts: attachments.map(a => ({ id: a.preview!.draftId, title: a.preview!.title, path: a.path })) }) + '\n```';
assert.equal(stripPublishedPreviewManifests('Choose a direction.\n\n' + manifest, attachments), 'Choose a direction.');
assert.match(stripPublishedPreviewManifests(manifest, []), /olympus-preview/, 'failed publication remains visible rather than silently disappearing');
assert.match(stripPublishedPreviewManifests('```olympus-preview\nnot json\n```', attachments), /not json/);
assert.match(TASK_AGENT_SYSTEM_PROMPT, /olympus-preview/);
assert.match(TASK_AGENT_SYSTEM_PROMPT, /2–3/);
assert.match(TASK_AGENT_SYSTEM_PROMPT, /self-contained/);
assert.match(TASK_AGENT_SYSTEM_PROMPT, /not.*deploy/i);
console.log('Inline preview UI and worker contract tests passed');
