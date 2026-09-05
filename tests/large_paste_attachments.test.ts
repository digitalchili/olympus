import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentTray, MessageAttachmentCards } from '../client/src/components/ChatAttachments.js';
import {
  CLIPBOARD_ATTACHMENT_MAX_BYTES,
  clipboardTextFileName,
  createClipboardTextAttachment,
  restoreClipboardAttachmentInline,
  shouldAttachClipboardText,
} from '../client/src/lib/largePasteAttachments.js';
import type { PendingFile } from '../client/src/hooks/useFileAttachments.js';

assert.equal(shouldAttachClipboardText('x'.repeat(3_999)), false, 'short text stays inline');
assert.equal(shouldAttachClipboardText('x'.repeat(4_000)), true, '4000 chars becomes an attachment');
assert.equal(shouldAttachClipboardText(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')), true, '50 lines becomes an attachment');
assert.equal(shouldAttachClipboardText(Array.from({ length: 49 }, (_, i) => `line ${i}`).join('\n')), false, '49 short lines stay inline');

const pasted = `First line <script>alert("x")</script> 😀\r\nSecond line\nCombining e\u0301 and emoji 🚀\n`;
const created = createClipboardTextAttachment(pasted);
assert.equal(created.ok, true, 'large paste creates a text attachment');
if (!created.ok) throw new Error(created.error);
assert.equal(created.file.type, 'text/plain;charset=utf-8');
assert.equal(created.file.size, Buffer.byteLength(pasted, 'utf8'));
assert.equal(Buffer.from(await created.file.arrayBuffer()).toString('utf8'), pasted, 'file bytes preserve exact Unicode and newlines');
assert.equal(created.metadata.preview, 'First line <script>alert("x")</script> 😀');
assert.equal(created.metadata.lineCount, 4);
assert.equal(created.metadata.size, Buffer.byteLength(pasted, 'utf8'));
assert.ok(created.file.name.endsWith('.txt'));
assert.ok(created.file.name.length <= 96, 'generated filename is bounded');
assert.doesNotMatch(created.file.name, /<|>|script/i, 'generated filename does not copy raw private/html content');
assert.match(clipboardTextFileName('   '), /^clipboard-paste\.txt$/);
assert.equal(clipboardTextFileName('Confidential case details'), 'clipboard-paste.txt', 'private clipboard content never becomes a filename or URL');

const oversizedText = `${'😀'.repeat(Math.ceil(CLIPBOARD_ATTACHMENT_MAX_BYTES / 4) + 1)}`;
const oversized = createClipboardTextAttachment(oversizedText);
assert.equal(oversized.ok, false, 'oversized paste is rejected instead of truncated');
if (oversized.ok) throw new Error('expected oversized paste to fail');
assert.match(oversized.error, /too large/i);

assert.deepEqual(
  restoreClipboardAttachmentInline({
    currentValue: 'before after',
    snapshotValue: 'before after',
    selectionStart: 7,
    selectionEnd: 7,
    text: 'PASTED',
  }),
  { value: 'before PASTEDafter', cursor: 13 },
  'unchanged draft restores at the original caret',
);
assert.deepEqual(
  restoreClipboardAttachmentInline({
    currentValue: 'user kept typing',
    snapshotValue: 'before after',
    selectionStart: 7,
    selectionEnd: 7,
    text: 'PASTED',
  }),
  { value: 'user kept typing\nPASTED', cursor: 23 },
  'changed draft appends instead of clobbering current text',
);

const pending: PendingFile = {
  id: 'paste-1',
  file: created.file,
  previewUrl: 'blob:clipboard-paste',
  status: 'uploaded',
  uploadedPath: '~/.olympus-dispatch/workspace/uploads/task/paste-1-clipboard-paste.txt',
  textAttachment: created.metadata,
};
const trayMarkup = renderToStaticMarkup(createElement(AttachmentTray, {
  files: [pending],
  onRemove() {},
  onRestoreText() {},
}));
assert.match(trayMarkup, /First line/);
assert.match(trayMarkup, /4 lines/);
assert.match(trayMarkup, /Preview pasted text/);
assert.match(trayMarkup, /Keep inline/);
assert.match(trayMarkup, /Remove/);
assert.doesNotMatch(trayMarkup, /<script>/i, 'text previews render as escaped text, not executable HTML');

const historyMarkup = renderToStaticMarkup(createElement(MessageAttachmentCards, {
  paths: ['~/.olympus-dispatch/workspace/uploads/task/12345678-1234-1234-1234-123456789abc-First line <script>alert(1)</script>.txt'],
}));
assert.match(historyMarkup, /Download/);
assert.match(historyMarkup, /Text/);
assert.doesNotMatch(historyMarkup, /<script>/i, 'persisted attachment names are escaped');

const root = await mkdtemp(join(tmpdir(), 'olympus-large-paste-upload-'));
const olympusHome = join(root, 'state');
const workspace = join(olympusHome, 'workspace');
const projectRoot = join(root, 'projects');
const originalFetch = globalThis.fetch;
process.env.OLYMPUS_DISPATCH_HOME = olympusHome;
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = projectRoot;
process.env.HERMES_HOME = join(root, 'hermes');
await mkdir(workspace, { recursive: true });
await mkdir(projectRoot, { recursive: true });

const [{ uploadChatAttachment }, { filesRouter }] = await Promise.all([
  import('../client/src/lib/api.js'),
  import('../server/routes/files.js'),
]);
const app = express();
app.use('/api/files', filesRouter);
const server = createServer(app);
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return originalFetch(new URL(requestUrl, baseUrl), init);
  }) as typeof fetch;

  const uploadedPath = await uploadChatAttachment('task-large-paste', 'paste-file', created.file);
  assert.equal(
    await readFile(join(workspace, 'uploads', 'task-large-paste', `paste-file-${created.file.name}`), 'utf8'),
    pasted,
    'large paste uploads exact UTF-8 bytes through the shared upload API',
  );
  assert.match(uploadedPath, /~\/\.olympus-dispatch\/workspace\/uploads\/task-large-paste\/paste-file-/);
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
const newTaskSource = await readFile('client/src/components/NewTaskPage.tsx', 'utf8');
assert.match(taskChatSource, /useFileAttachments\(taskId, \{/);
assert.match(newTaskSource, /useFileAttachments\(uploadBucketId, \{/);

console.log('Large paste attachment tests passed');
