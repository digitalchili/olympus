import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, rename, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { LocalProfileRegistry } from '../server/local-profiles.js';
import { createTaskArtifactsRouter, publishTaskAttachments } from '../server/task-artifacts.js';
import { publishTaskArtifactPreview, openPublishedTaskPreview } from '../server/task-previews.js';
import type { Task, TaskAttachment, TaskDraftSelection } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-inline-previews-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');

const hermesHome = join(root, 'hermes');
const stateHome = join(root, 'state');
const profileId = `preview-profile-${process.pid}`;
const profileHome = join(hermesHome, 'profiles', profileId);
const workspace = join(profileHome, 'workspace');
const projectWorkdir = join(root, 'project');
const draftAPath = join(projectWorkdir, 'drafts', 'homepage-r1', 'a.html');
const draftBPath = join(projectWorkdir, 'drafts', 'homepage-r1', 'b.html');
const unsafeHtmlPath = join(projectWorkdir, 'unsafe.html');
const imagePath = join(projectWorkdir, 'hero.png');
const renamedHtmlPath = join(projectWorkdir, 'renamed-html.png');
const svgPath = join(projectWorkdir, 'vector.svg');
const pdfPath = join(projectWorkdir, 'brief.pdf');

const pngOne = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('first immutable png bytes', 'utf8'),
]);
const pngTwo = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('changed mutable source bytes', 'utf8'),
]);
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n', 'utf8');
const htmlA = '<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><h1>Editorial direction</h1><script>window.previewReady=true;</script><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"></body></html>';
const htmlAChanged = '<!doctype html><html><body><h1>Changed mutable source</h1></body></html>';
const htmlB = '<!doctype html><html><head><style>main{color:#123}</style></head><body><main>Conversion-focused direction</main><script>document.body.dataset.ready="1";</script></body></html>';
const unsafeHtml = '<!doctype html><html><body><script src="https://example.invalid/app.js"></script></body></html>';
const renamedHtml = '<!doctype html><html><body><script>alert("not an image")</script></body></html>';
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("x")</script><rect width="10" height="10"/></svg>';

function makeTask(id: string): Task {
  const now = Date.now();
  return {
    id,
    title: 'Review homepage drafts',
    description: null,
    status: 'in_review',
    profile_name: profileId,
    routing_source: 'manual',
    agent_model: null,
    agent_provider: null,
    reasoning_effort: null,
    workdir: projectWorkdir,
    project_id: null,
    handling_profile_id: null,
    delegated_worker_id: null,
    created_at: now,
    updated_at: now,
    last_agent_response_at: now,
    last_viewed_at: null,
    last_context_used_tokens: null,
    last_context_window_tokens: null,
  };
}

function byName(attachments: TaskAttachment[], name: string): TaskAttachment {
  const attachment = attachments.find((item) => item.name === name);
  assert.ok(attachment, `missing attachment ${name}`);
  return attachment;
}

async function bodyJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(draftAPath), { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await writeFile(join(profileHome, 'profile.yaml'), 'displayName: Preview Test Profile\nactive: true\n');
  await writeFile(join(profileHome, 'config.yaml'), '{}\n');
  await writeFile(imagePath, pngOne);
  await writeFile(draftAPath, htmlA);
  await writeFile(draftBPath, htmlB);
  await writeFile(unsafeHtmlPath, unsafeHtml);
  await writeFile(renamedHtmlPath, renamedHtml);
  await writeFile(svgPath, svg);
  await writeFile(pdfPath, pdfBytes);

  const task = makeTask(`task-preview-${process.pid}`);
  const otherTask = makeTask(`task-preview-other-${process.pid}`);
  const registry = new LocalProfileRegistry(hermesHome, stateHome);
  const manifestContent = `Generated drafts are ready.\n\nMEDIA:${imagePath}\n\n\`\`\`olympus-preview\n${JSON.stringify({
    id: 'homepage-r1',
    title: 'Homepage directions',
    drafts: [
      { id: 'a', title: 'Editorial', description: 'Story-led layout', path: 'drafts/homepage-r1/a.html' },
      { id: 'b', title: 'Conversion-focused', description: 'Lead form first', path: 'drafts/homepage-r1/b.html' },
    ],
  }, null, 2)}\n\`\`\``;

  const attachments = await publishTaskAttachments(task, manifestContent, registry);
  const image = byName(attachments, 'hero.png');
  assert.equal(image.path, imagePath);
  assert.equal(image.size, pngOne.length);
  assert.equal(image.preview?.kind, 'image');
  assert.equal(image.preview?.title, 'hero.png');
  assert.ok(image.preview?.id.startsWith('media-'));

  const draftA = byName(attachments, 'a.html');
  assert.equal(draftA.path, 'drafts/homepage-r1/a.html');
  assert.equal(draftA.preview?.id, 'homepage-r1:a');
  assert.equal(draftA.preview?.kind, 'html');
  assert.equal(draftA.preview?.title, 'Editorial');
  assert.equal(draftA.preview?.description, 'Story-led layout');
  assert.equal(draftA.preview?.groupId, 'homepage-r1');
  assert.equal(draftA.preview?.groupTitle, 'Homepage directions');
  assert.equal(draftA.preview?.draftId, 'a');

  const draftB = byName(attachments, 'b.html');
  assert.equal(draftB.preview?.id, 'homepage-r1:b');
  assert.equal(draftB.preview?.kind, 'html');
  assert.equal(draftB.preview?.title, 'Conversion-focused');

  const unsafeAttachments = await publishTaskAttachments(task, [
    `MEDIA:${unsafeHtmlPath}`,
    `MEDIA:${renamedHtmlPath}`,
    `MEDIA:${svgPath}`,
    `MEDIA:${pdfPath}`,
  ].join('\n'), registry);
  assert.equal(byName(unsafeAttachments, 'unsafe.html').preview, undefined, 'HTML with remote script stays a download');
  assert.equal(byName(unsafeAttachments, 'renamed-html.png').preview, undefined, 'renamed HTML is not trusted as an image');
  assert.equal(byName(unsafeAttachments, 'vector.svg').preview, undefined, 'SVG is not served as an inline image preview');
  assert.deepEqual(byName(unsafeAttachments, 'brief.pdf'), { path: pdfPath, name: 'brief.pdf', size: pdfBytes.length });

  const swappedPath = join(projectWorkdir, 'swapped.png');
  await writeFile(swappedPath, pngOne);
  const approved = { path: swappedPath, name: 'swapped.png', size: pngOne.length, realPath: swappedPath, handle: await open(swappedPath, 'r') };
  try {
    await rename(swappedPath, swappedPath + '.original');
    await writeFile(swappedPath, pngTwo);
    const preview = await publishTaskArtifactPreview(task, approved);
    assert.ok(preview, 'publication reads the approved descriptor after a pathname replacement');
    const snapshot = await openPublishedTaskPreview(task.id, preview.id);
    try { const bytes = Buffer.alloc(pngOne.length); await snapshot.handle.read(bytes, 0, bytes.length, 0); assert.deepEqual(bytes, pngOne); } finally { await snapshot.handle.close(); }
  } finally { await approved.handle.close(); }

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskArtifactsRouter({
    getTask: (id) => id === task.id ? task : id === otherTask.id ? otherTask : undefined,
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
    const taskBase = `http://127.0.0.1:${address.port}/api/tasks/${task.id}/artifacts`;
    const otherTaskBase = `http://127.0.0.1:${address.port}/api/tasks/${otherTask.id}/artifacts`;
    const profileQuery = `profile=${encodeURIComponent(profileId)}`;

    const imagePreview = await fetch(`${taskBase}/preview/${encodeURIComponent(image.preview!.id)}?${profileQuery}`);
    assert.equal(imagePreview.status, 200);
    assert.match(imagePreview.headers.get('content-type') ?? '', /^image\/png\b/);
    assert.equal(imagePreview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(imagePreview.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(Buffer.from(await imagePreview.arrayBuffer()), pngOne);

    const htmlPreview = await fetch(`${taskBase}/preview/${encodeURIComponent(draftA.preview!.id)}?${profileQuery}`);
    assert.equal(htmlPreview.status, 200);
    assert.match(htmlPreview.headers.get('content-type') ?? '', /^text\/html\b/);
    assert.equal(htmlPreview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlPreview.headers.get('referrer-policy'), 'no-referrer');
    const csp = htmlPreview.headers.get('content-security-policy') ?? '';
    assert.match(csp, /sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
    ]) {
      assert.ok(csp.includes(directive), `missing CSP directive ${directive}`);
    }
    const previewDocument = await htmlPreview.text();
    assert.match(previewDocument, /<iframe[^>]+sandbox="allow-scripts"[^>]+srcdoc=/, 'an outer document must constrain prototype self-navigation');
    assert.ok(previewDocument.includes('Editorial direction'));
    const download = await fetch(`${taskBase}/preview/${encodeURIComponent(draftA.preview!.id)}?${profileQuery}&download=1`);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(await download.text(), htmlA, 'download preserves original immutable HTML bytes');

    await writeFile(imagePath, pngTwo);
    await writeFile(draftAPath, htmlAChanged);
    const rehydrated = await publishTaskAttachments(task, manifestContent, registry);
    assert.equal(byName(rehydrated, 'hero.png').preview?.id, image.preview!.id);
    assert.equal(byName(rehydrated, 'a.html').preview?.id, draftA.preview!.id);

    const imageAfterMutation = await fetch(`${taskBase}/preview/${encodeURIComponent(image.preview!.id)}?${profileQuery}`);
    assert.equal(imageAfterMutation.status, 200);
    assert.deepEqual(Buffer.from(await imageAfterMutation.arrayBuffer()), pngOne, 'MEDIA preview serves first-published bytes, not the mutated source');

    const htmlAfterMutation = await fetch(`${taskBase}/preview/${encodeURIComponent(draftA.preview!.id)}?${profileQuery}`);
    assert.equal(htmlAfterMutation.status, 200);
    assert.equal(await htmlAfterMutation.text(), previewDocument, 'manifest preview serves first-published bytes, not the mutated source');

    const wrongProfile = await fetch(`${taskBase}/preview/${encodeURIComponent(draftA.preview!.id)}?profile=default`);
    assert.equal(wrongProfile.status, 404);

    const crossTaskPreview = await fetch(`${otherTaskBase}/preview/${encodeURIComponent(draftA.preview!.id)}?${profileQuery}`);
    assert.equal(crossTaskPreview.status, 404);

    const badPreviewId = await fetch(`${taskBase}/preview/${encodeURIComponent('../escape')}?${profileQuery}`);
    assert.equal(badPreviewId.status, 400);

    const initialSelections = await fetch(`${taskBase}/selections?${profileQuery}`);
    assert.equal(initialSelections.status, 200);
    assert.deepEqual(await bodyJson<{ selections: TaskDraftSelection[] }>(initialSelections), { selections: [] });

    const beforeSelect = Date.now();
    const selectedResponse = await fetch(`${taskBase}/selections?${profileQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: 'homepage-r1', previewId: draftB.preview!.id, feedback: '  Make the CTA warmer.  ' }),
    });
    assert.equal(selectedResponse.status, 200);
    const selected = await bodyJson<{ selection: TaskDraftSelection }>(selectedResponse);
    assert.equal(selected.selection.groupId, 'homepage-r1');
    assert.equal(selected.selection.previewId, draftB.preview!.id);
    assert.equal(selected.selection.title, 'Conversion-focused');
    assert.equal(selected.selection.feedback, 'Make the CTA warmer.');
    assert.ok(selected.selection.selectedAt >= beforeSelect && selected.selection.selectedAt <= Date.now());
    assert.match(selected.selection.prompt, /Homepage directions/);
    assert.match(selected.selection.prompt, /Conversion-focused/);
    assert.match(selected.selection.prompt, /homepage-r1:b/);
    assert.match(selected.selection.prompt, /Make the CTA warmer\./);
    assert.doesNotMatch(selected.selection.prompt, /deploy|push|approve/i);

    const persistedSelections = await fetch(`${taskBase}/selections?${profileQuery}`);
    assert.equal(persistedSelections.status, 200);
    assert.deepEqual(await bodyJson<{ selections: TaskDraftSelection[] }>(persistedSelections), { selections: [selected.selection] });

    const ordinaryMediaSelection = await fetch(`${taskBase}/selections?${profileQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: 'homepage-r1', previewId: image.preview!.id }),
    });
    assert.equal(ordinaryMediaSelection.status, 404);

    const invalidSelectionId = await fetch(`${taskBase}/selections?${profileQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: 'homepage-r1', previewId: '../escape' }),
    });
    assert.equal(invalidSelectionId.status, 400);

    const crossTaskSelection = await fetch(`${otherTaskBase}/selections?${profileQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: 'homepage-r1', previewId: draftB.preview!.id }),
    });
    assert.equal(crossTaskSelection.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Inline preview and draft selection tests passed');
