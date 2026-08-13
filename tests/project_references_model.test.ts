import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-refs-model-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'project-refs.db');

try {
  const { createProject, grantProjectProfileAccess } = await import('../server/db/projects.js');
  const {
    createProjectReferenceFromQuarantine,
    deleteProjectReference,
    getProjectReference,
    listProjectReferenceChunks,
    listProjectReferences,
    reindexProjectReference,
    searchProjectReferences,
    validateProjectReferenceCandidate,
  } = await import('../server/db/project-references.js');
  const { canProfileAccessProject } = await import('../server/project-access.js');
  const { default: db } = await import('../server/db/index.js');

  const project = createProject({
    name: 'Reference Fixture Project',
    purpose: 'Synthetic reference ingestion tests',
    managerProfileId: 'manager',
    changedBy: 'local-user',
  }, 1_000);
  grantProjectProfileAccess({ projectId: project.id, profileId: 'reader', role: 'view', grantedBy: 'local-user' }, 1_050);

  assert.equal(canProfileAccessProject(project.id, 'manager', 'manage'), true);
  assert.equal(canProfileAccessProject(project.id, 'reader', 'view'), true);
  assert.equal(canProfileAccessProject(project.id, 'reader', 'contribute'), false);
  assert.equal(canProfileAccessProject(project.id, 'stranger', 'view'), false, 'Project ACLs fail closed for reference callers');

  assert.throws(
    () => validateProjectReferenceCandidate({ originalFilename: '../secrets.txt', mimeType: 'text/plain', sizeBytes: 12 }),
    /safe filename/i,
  );
  assert.throws(
    () => validateProjectReferenceCandidate({ originalFilename: 'script.txt', mimeType: 'application/pdf', sizeBytes: 12 }),
    /does not match/i,
  );
  assert.throws(
    () => validateProjectReferenceCandidate({ originalFilename: 'payload.zip', mimeType: 'application/zip', sizeBytes: 12 }),
    /not supported/i,
  );

  const quarantine = join(root, 'fixture-upload.txt');
  await writeFile(quarantine, 'Launch checklist\nAlpha beta gamma\nGamma delta evidence\n', 'utf8');
  const reference = await createProjectReferenceFromQuarantine({
    projectId: project.id,
    quarantinePath: quarantine,
    originalFilename: 'Launch Notes.txt',
    mimeType: 'text/plain',
    sizeBytes: (await stat(quarantine)).size,
    now: 2_000,
  });

  assert.equal(reference.projectId, project.id);
  assert.equal(reference.originalFilename, 'Launch Notes.txt');
  assert.equal(reference.extension, '.txt');
  assert.equal(reference.status, 'indexed');
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(reference.storagePath, 'utf8'), 'Launch checklist\nAlpha beta gamma\nGamma delta evidence\n');

  const listed = listProjectReferences(project.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].storagePath, undefined, 'list projection never exposes immutable storage paths');
  assert.equal(getProjectReference(project.id, reference.id)?.storagePath, reference.storagePath);

  const chunks = listProjectReferenceChunks(project.id, reference.id);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[0].pageNumber, null);
  assert.equal(chunks[0].sheetName, null);
  assert.match(chunks[0].text, /Alpha beta gamma/);

  const results = searchProjectReferences(project.id, 'gamma');
  assert.equal(results.length, 1);
  assert.equal(results[0].referenceId, reference.id);
  assert.equal(results[0].citation.originalFilename, 'Launch Notes.txt');
  assert.equal(results[0].citation.chunkIndex, 0);
  assert.match(results[0].snippet, /gamma/i);

  await reindexProjectReference(project.id, reference.id, 3_000);
  assert.equal(getProjectReference(project.id, reference.id)?.status, 'indexed');
  assert.equal(searchProjectReferences(project.id, 'delta').length, 1);

  deleteProjectReference(project.id, reference.id, 4_000);
  assert.equal(getProjectReference(project.id, reference.id)?.status, 'deleted');
  assert.equal(listProjectReferences(project.id).length, 0);
  assert.equal(searchProjectReferences(project.id, 'gamma').length, 0, 'delete removes retrieval index entries');

  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project reference model, storage, extraction, and retrieval tests passed');
