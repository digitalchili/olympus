import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageAttachmentCards } from '../client/src/components/ChatAttachments.js';
import { splitAttachmentMessage } from '../client/src/lib/format.js';
import { LocalProfileRegistry } from '../server/local-profiles.js';
import { createTaskArtifactsRouter, publishTaskAttachments } from '../server/task-artifacts.js';
import type { Task } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-artifacts-'));
const hermesHome = join(root, 'hermes');
const profileId = `artifact-profile-${process.pid}`;
const profileHome = join(hermesHome, 'profiles', profileId);
const workspace = join(profileHome, 'workspace');
const projectWorkdir = join(root, 'project');
const fixtureName = 'generated review brief.pdf';
const fixturePath = join(projectWorkdir, fixtureName);
const emptyPath = join(workspace, 'empty.pdf');
const outsidePath = join(root, 'outside.pdf');
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n', 'utf8');
const task: Task = {
  id: `task-${process.pid}`,
  title: 'Generate a document',
  description: null,
  status: 'in_review',
  profile_name: profileId,
  routing_source: 'manual',
  agent_model: null,
  agent_provider: null,
  reasoning_effort: null,
  workdir: projectWorkdir,
  created_at: Date.now(),
  updated_at: Date.now(),
  last_agent_response_at: Date.now(),
  last_viewed_at: null,
  last_context_used_tokens: null,
  last_context_window_tokens: null,
};

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(projectWorkdir, { recursive: true });
  await writeFile(join(profileHome, 'profile.yaml'), 'description: Artifact test profile\n');
  await writeFile(fixturePath, pdfBytes);
  await writeFile(emptyPath, Buffer.alloc(0));
  await writeFile(outsidePath, Buffer.from('not approved'));

  const registry = new LocalProfileRegistry(hermesHome);
  const content = `Your document is ready.\n\nMEDIA:${fixturePath}`;
  const split = splitAttachmentMessage(content);
  assert.equal(split.text, 'Your document is ready.');
  assert.deepEqual(split.filePaths, [fixturePath]);

  const attachments = await publishTaskAttachments(task, content, registry);
  assert.deepEqual(attachments, [{ path: fixturePath, name: fixtureName, size: pdfBytes.length }]);
  assert.deepEqual(await publishTaskAttachments(task, `MEDIA:${emptyPath}`, registry), []);
  assert.deepEqual(await publishTaskAttachments(task, `MEDIA:${outsidePath}`, registry), []);

  const markup = renderToStaticMarkup(createElement(MessageAttachmentCards, {
    taskId: task.id,
    attachments,
  }));
  assert.match(markup, /generated review brief\.pdf/);
  assert.match(markup, /Download generated review brief\.pdf/);
  assert.match(markup, new RegExp(`/api/tasks/${task.id}/artifacts/download\\?path=`));
  assert.match(markup, / PDF<\/span>/);

  const app = express();
  app.use('/api/tasks', createTaskArtifactsRouter({
    getTask: (id) => id === task.id ? task : undefined,
    registry,
  }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/tasks/${task.id}/artifacts/download`;
    const response = await fetch(`${base}?path=${encodeURIComponent(fixturePath)}&profile=${encodeURIComponent(profileId)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(pdfBytes.length));
    assert.match(response.headers.get('content-type') ?? '', /^application\/pdf\b/);
    assert.match(response.headers.get('content-disposition') ?? '', /generated review brief\.pdf/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);

    const emptyResponse = await fetch(`${base}?path=${encodeURIComponent(emptyPath)}&profile=${encodeURIComponent(profileId)}`);
    assert.equal(emptyResponse.status, 422);
    assert.equal((await emptyResponse.json()).code, 'EMPTY_ARTIFACT');

    const outsideResponse = await fetch(`${base}?path=${encodeURIComponent(outsidePath)}&profile=${encodeURIComponent(profileId)}`);
    assert.equal(outsideResponse.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
  assert.match(taskChatSource, /<MessageAttachmentCards taskId=\{taskId\} attachments=\{msg\.attachments \?\? \[\]\} \/>/);
  assert.match(taskChatSource, /<MarkdownContent content=\{assistantText\}/);
  assert.match(taskChatSource, /shouldShowReplyCopyButton\(assistantText, isLastAssistant && isStreaming\)/);
  assert.match(taskChatSource, /<ReplyCopyButton content=\{assistantText\} \/>/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Assistant attachment download tests passed');
