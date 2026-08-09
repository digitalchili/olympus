import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-chat-upload-'));
const olympusHome = join(root, 'state');
const workspace = join(olympusHome, 'workspace');
const projectRoot = join(root, 'projects');

process.env.OLYMPUS_DISPATCH_HOME = olympusHome;
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = projectRoot;
process.env.HERMES_HOME = join(root, 'hermes');

await mkdir(workspace, { recursive: true });
await mkdir(projectRoot, { recursive: true });

const [{ filesRouter }, { ApiError, uploadChatAttachment }] = await Promise.all([
  import('../server/routes/files.js'),
  import('../client/src/lib/api.js'),
]);

const app = express();
app.use('/api/files', filesRouter);
const server = createServer(app);
const originalFetch = globalThis.fetch;

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    return originalFetch(new URL(requestUrl, baseUrl), init);
  }) as typeof fetch;

  const bucketId = 'task-chat-attachment';
  const fileId = 'file-123';
  const fileName = 'brief final.txt';
  const content = 'persistent attachment contents';
  const uploadedPath = await uploadChatAttachment(
    bucketId,
    fileId,
    new File([content], fileName, { type: 'text/plain' }),
  );

  assert.equal(
    uploadedPath,
    `~/.olympus-dispatch/workspace/uploads/${bucketId}/${fileId}-${fileName}`,
  );
  assert.equal(
    await readFile(join(workspace, 'uploads', bucketId, `${fileId}-${fileName}`), 'utf8'),
    content,
    'chat attachments must persist in the configured internal workspace, not only multer temp storage',
  );

  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(workspace, 'uploads', 'escaped-bucket'), 'dir');
  await assert.rejects(
    uploadChatAttachment(
      'escaped-bucket',
      'blocked-file',
      new File(['blocked'], 'blocked.txt', { type: 'text/plain' }),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'EEXIST',
    'nested upload creation must reject symlinked directories',
  );
  await assert.rejects(access(join(outside, 'blocked-file-blocked.txt')));
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log('Chat attachment workspace persistence tests passed');
