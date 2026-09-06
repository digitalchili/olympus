import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { test, after, mock } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'olympus-upload-atomicity-'));
const workspace = join(root, 'state', 'workspace');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_PROJECT_ROOT = workspace;
process.env.DB_PATH = join(root, 'test.db');
await mkdir(workspace, { recursive: true });
const { filesRouter } = await import('../server/routes/files.js');
const app = express();
app.use('/api/files', filesRouter);
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/api/files/upload`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
async function upload(entries: Array<[string, string]>) {
  const form = new FormData();
  form.append('targetPath', workspace);
  for (const [path, content] of entries) {
    form.append('files', new Blob([content]), path.split('/').at(-1)!);
    form.append('relativePaths', path);
  }
  const result = await fetch(url, { method: 'POST', body: form });
  await result.json();
  return result.status;
}

test('a later invalid upload entry preserves overwritten original bytes', async () => {
  await writeFile(join(workspace, 'original.txt'), 'original bytes');
  assert.equal(await upload([['original.txt', 'replacement'], ['../escape.txt', 'bad']]), 400);
  assert.equal(await readFile(join(workspace, 'original.txt'), 'utf8').catch(() => null), 'original bytes');
});

test('a later filesystem conflict rolls back prior new files and replacements', async () => {
  await writeFile(join(workspace, 'original.txt'), 'original bytes');
  await mkdir(join(workspace, 'existing-dir'), { recursive: true });
  assert.equal(await upload([['original.txt', 'replacement'], ['new.txt', 'new'], ['existing-dir', 'bad']]), 409);
  assert.equal(await readFile(join(workspace, 'original.txt'), 'utf8').catch(() => null), 'original bytes');
  await assert.rejects(access(join(workspace, 'new.txt')));
});

test('successful uploads retain replacement behavior and nested files', async () => {
  await writeFile(join(workspace, 'original.txt'), 'original bytes');
  assert.equal(await upload([['original.txt', 'replacement'], ['nested/new.txt', 'new']]), 201);
  assert.equal(await readFile(join(workspace, 'original.txt'), 'utf8'), 'replacement');
  assert.equal(await readFile(join(workspace, 'nested', 'new.txt'), 'utf8'), 'new');
});

test('an I/O error during commit restores originals and removes new files', async () => {
  await writeFile(join(workspace, 'original.txt'), 'original bytes');
  const rename = fs.rename;
  const fault = mock.method(fs, 'rename', async (from, to) => {
    if (String(from).endsWith('.next') && String(to).endsWith('/late.txt')) {
      throw Object.assign(new Error('simulated destination I/O failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await upload([['original.txt', 'replacement'], ['new.txt', 'new'], ['late.txt', 'late']]), 500);
    assert.equal(await readFile(join(workspace, 'original.txt'), 'utf8'), 'original bytes');
    await assert.rejects(access(join(workspace, 'new.txt')));
    assert.equal((await readdir(workspace)).some((name) => name.startsWith('.olympus-upload-')), false);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});

test('concurrent failed and successful replacements preserve the successful result', { timeout: 5000 }, async () => {
  await writeFile(join(workspace, 'original.txt'), 'original bytes');
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atFailure = new Promise<void>((resolve) => { reached = resolve; });
  const rename = fs.rename;
  const fault = mock.method(fs, 'rename', async (from, to) => {
    if (String(from).endsWith('.next') && String(to).endsWith('/late.txt')) {
      reached();
      await blocked;
      throw Object.assign(new Error('simulated destination I/O failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const failing = upload([['original.txt', 'failed replacement'], ['late.txt', 'late']]);
    await atFailure;
    const succeeding = upload([['original.txt', 'successful replacement']]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    assert.deepEqual(await Promise.all([failing, succeeding]), [500, 201]);
    assert.equal(await readFile(join(workspace, 'original.txt'), 'utf8'), 'successful replacement');
  } finally {
    release();
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});
