import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-deleted-attachment-sync-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'state', 'test.db');
const { createProject, deleteProject } = await import('../server/db/projects.js');
const { syncMessageAttachmentsToProjectReferences } = await import('../server/db/project-references.js');
const { claimProjectConfigurationOperation } = await import('../server/task-run-lifecycle.js');
const { resolveProjectReferencesDir } = await import('../server/paths.js');
const { default: db } = await import('../server/db/index.js');
await mkdir(join(root, 'originals'), { recursive: true });
const source = join(root, 'originals', 'reference.txt');
await writeFile(source, 'Attachment import fixture');
const message = `MEDIA:${source}`;
const project = createProject({ name: 'Queued attachments', purpose: 'Deletion fixture', managerProfileId: 'default', changedBy: 'test' });
const storage = join(resolveProjectReferencesDir(), project.id);

try {
  const release = claimProjectConfigurationOperation(project.id);
  assert.ok(release);
  try {
    assert.deepEqual(await syncMessageAttachmentsToProjectReferences(project.id, message), [], 'queued attachment imports cannot enter while Project deletion owns the namespace');
    assert.equal(existsSync(storage), false);
  } finally { release(); }

  const importing = syncMessageAttachmentsToProjectReferences(project.id, message);
  const deletion = claimProjectConfigurationOperation(project.id);
  if (deletion) deletion();
  assert.equal(deletion, null, 'Project deletion must wait until an accepted attachment import settles');
  assert.equal((await importing).length, 1);

  assert.ok(deleteProject(project.id, []));
  await rm(storage, { recursive: true, force: true });
  assert.deepEqual(await syncMessageAttachmentsToProjectReferences(project.id, message), [], 'stale queued-message state cannot recreate a deleted Project directory');
  assert.equal(existsSync(storage), false);
  assert.equal(existsSync(source), true, 'original external attachments remain untouched');
  console.log('Queued attachment import and Project deletion fencing tests passed');
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
