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
    createProjectReferenceFromFile,
    syncMessageAttachmentsToProjectReferences,
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

  // Test createProjectReferenceFromFile with UUID-prefixed chat upload
  const uploadsDir = join(root, 'workspace', 'uploads', 'task-123');
  const { mkdir: mkdirp } = await import('node:fs/promises');
  await mkdirp(uploadsDir, { recursive: true });
  const csvAttachment = join(uploadsDir, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890-catalog_products.csv');
  await writeFile(csvAttachment, 'sku,title,price\nPRK-01,Prikpot Special,250\n', 'utf8');

  const syncedCsv = await createProjectReferenceFromFile({
    projectId: project.id,
    filePath: csvAttachment,
    now: 5_000,
  });
  assert.ok(syncedCsv);
  assert.equal(syncedCsv.originalFilename, 'catalog_products.csv', 'UUID prefix is cleaned for user-friendly display');
  assert.equal(syncedCsv.status, 'indexed');
  assert.equal((await stat(csvAttachment)).size > 0, true, 'original task chat attachment file remains intact');
  assert.equal(listProjectReferences(project.id).length, 1);

  // Test syncMessageAttachmentsToProjectReferences from a chat message block
  const mdAttachment = join(uploadsDir, '12345678-1234-1234-1234-123456789abc-woo_migration_guide.md');
  await writeFile(mdAttachment, '# WooCommerce to Vendure\nComprehensive migration plan for prikpot.\n', 'utf8');
  const pyIgnored = join(uploadsDir, 'script.py');
  await writeFile(pyIgnored, 'print("ignore me")\n', 'utf8');

  const chatMessage = `Here are the migration documents:\n\n[Attached files:\n- ${mdAttachment}\n- ${pyIgnored}\n]`;
  const syncedRefs = await syncMessageAttachmentsToProjectReferences(project.id, chatMessage);
  assert.equal(syncedRefs.length, 1, 'only supported document formats are synced to references');
  assert.equal(syncedRefs[0].originalFilename, 'woo_migration_guide.md');

  const searchHits = searchProjectReferences(project.id, 'Vendure');
  assert.equal(searchHits.length, 1);
  assert.equal(searchHits[0].citation.originalFilename, 'woo_migration_guide.md');

  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project reference model, storage, extraction, and retrieval tests passed');
