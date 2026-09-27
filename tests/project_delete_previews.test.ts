import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-deleted-previews-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'state', 'test.db');
const previews = await import('../server/task-previews.js');
const { insertTask, deleteTask } = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');
const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('preview fixture')]);
await mkdir(join(root, 'source'), { recursive: true });
const source = join(root, 'source', 'image.png');
await writeFile(source, bytes);
const handle = await open(source, 'r');
const artifact = { path: source, realPath: source, name: 'image.png', size: bytes.length, handle };

try {
  assert.equal(typeof previews.withTaskPreviewCleanup, 'function', 'disk cleanup must serialize with preview writes');
  const task = insertTask({ title: 'Preview deletion race', status: 'in_review' });
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const originalRead = handle.read.bind(handle);
  handle.read = (async (...args: Parameters<typeof originalRead>) => {
    entered();
    await blocked;
    return originalRead(...args);
  }) as typeof handle.read;

  const inFlight = previews.publishTaskArtifactPreview(task, artifact);
  await reading;
  const queued = previews.publishTaskArtifactPreview(task, artifact);
  assert.ok(deleteTask(task.id));
  let cleaned = false;
  const cleanup = previews.withTaskPreviewCleanup([task.id], async () => {
    await rm(previews.taskPreviewStorageDir(task.id), { recursive: true, force: true });
    cleaned = true;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cleaned, false, 'cleanup must wait for an already-running preview publication');
  assert.equal(await previews.publishTaskArtifactPreview(task, artifact), undefined, 'stale history must not queue new publication');
  resume();
  await Promise.all([inFlight, cleanup]);
  assert.equal(await queued, undefined, 'publication queued before deletion must recheck task existence');
  assert.equal(existsSync(previews.taskPreviewStorageDir(task.id)), false, 'cleanup leaves no recreated snapshots');
  assert.equal(existsSync(source), true, 'preview cleanup never removes the original source');
  handle.read = originalRead as typeof handle.read;

  const selectionTask = insertTask({ title: 'Deleted selection', status: 'in_review' });
  const preview = await previews.publishTaskArtifactPreview(selectionTask, artifact, {
    previewId: 'drafts:a', title: 'Draft A', groupId: 'drafts', draftId: 'a',
  });
  assert.ok(preview);
  assert.ok(deleteTask(selectionTask.id));
  await previews.withTaskPreviewCleanup([selectionTask.id], () => rm(previews.taskPreviewStorageDir(selectionTask.id), { recursive: true, force: true }));
  await assert.rejects(previews.saveTaskDraftSelection(selectionTask.id, { groupId: 'drafts', previewId: preview.id }),
    (error: unknown) => error instanceof previews.TaskPreviewError && error.status === 404 && error.code === 'TASK_NOT_FOUND');
  assert.equal(existsSync(previews.taskPreviewStorageDir(selectionTask.id)), false);
  console.log('Deleted-task preview publication, queued writers, cleanup and selection race tests passed');
} finally {
  await handle.close();
  db.close();
  await rm(root, { recursive: true, force: true });
}
