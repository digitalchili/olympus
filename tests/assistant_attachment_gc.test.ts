import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Download streams must own the FileHandle, rather than a raw descriptor that
// the handle's finalizer may close while the response is still using it.
const gc = 'data:text/javascript,' + encodeURIComponent('setInterval(() => global.gc(), 5).unref();');
const result = await promisify(execFile)(process.execPath, [
  '--expose-gc', '--import', 'tsx', '--import', gc, 'tests/assistant_attachments.test.ts',
], { timeout: 15_000 });
assert.match(result.stdout, /Assistant attachment download tests passed/);
assert.doesNotMatch(result.stderr, /Closing file descriptor|EBADF/);
console.log('Attachment stream ownership regression passed');
