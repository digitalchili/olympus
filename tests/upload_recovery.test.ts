import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadLifecycle } from '../server/upload-lifecycle.js';
import { failedUpload, retryUpload, uploadBlocksSend } from '../client/src/lib/upload-recovery.js';

const upload = { id: 'attachment-1', status: 'uploading' as const };
const failed = failedUpload(upload, 'Upload timed out');
assert.deepEqual(failed, { id: 'attachment-1', status: 'error', error: 'Upload timed out' });
assert.equal(uploadBlocksSend([failed]), true, 'failed upload keeps Send gated until resolved');
const retried = retryUpload(failed);
assert.equal(retried.status, 'uploading');
assert.equal((retried as { error?: string }).error, undefined);
assert.equal(uploadBlocksSend([]), false, 'removing a failed upload unblocks Send');

const root = await mkdtemp(join(tmpdir(), 'olympus-upload-recovery-'));
const requestDir = join(root, 'request-1');
await mkdir(requestDir);
await writeFile(join(requestDir, 'partial.jpg'), 'partial');
const lifecycle = createUploadLifecycle({ requestId: 'request-1', requestDir, now: () => 1_000 });
await lifecycle.abort('client_aborted');
await assert.rejects(access(requestDir), /ENOENT/, 'aborted multipart requests remove their entire temp directory');
assert.deepEqual(lifecycle.logFields('aborted', 'client_aborted'), {
  event: 'upload', requestId: 'request-1', outcome: 'aborted', reason: 'client_aborted', elapsedMs: 0,
});

console.log('Upload recovery tests passed');
