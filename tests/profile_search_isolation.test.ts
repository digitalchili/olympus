import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-profile-search-isolation-'));
const hermesHome = join(root, 'hermes');
const writerHome = join(hermesHome, 'profiles', 'writer');
const reviewerHome = join(hermesHome, 'profiles', 'reviewer');
const dispatchHome = join(root, 'dispatch');
const previousHermesHome = process.env.HERMES_HOME;
const previousDispatchHome = process.env.OLYMPUS_DISPATCH_HOME;
const previousDbPath = process.env.DB_PATH;

function createHermesState(path: string, sessionId: string, content: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL NOT NULL
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(content);
  `);
  const result = db.prepare(
    'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
  ).run(sessionId, 'user', content, 123);
  db.prepare('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)').run(result.lastInsertRowid, content);
  db.close();
}

async function search(base: string, query: string, profile?: string, projectId?: string): Promise<Array<{ taskId: string; handlingProfileId: string; role: string; snippet: string }>> {
  const params = new URLSearchParams({ q: query });
  if (profile) params.set('profile', profile);
  if (projectId) params.set('projectId', projectId);
  const response = await fetch(`${base}/api/search?${params}`);
  assert.equal(response.status, 200);
  return (await response.json() as { results: Array<{ taskId: string; handlingProfileId: string; role: string; snippet: string }> }).results;
}

try {
  await mkdir(writerHome, { recursive: true });
  await mkdir(reviewerHome, { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
  await writeFile(join(writerHome, 'profile.yaml'), 'displayName: Writer\n');
  await writeFile(join(writerHome, 'config.yaml'), '{}\n');
  await writeFile(join(reviewerHome, 'profile.yaml'), 'displayName: Reviewer\n');
  await writeFile(join(reviewerHome, 'config.yaml'), '{}\n');
  process.env.HERMES_HOME = hermesHome;
  process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
  process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

  const [{ searchRouter }, queries, projects, { default: dispatchDb }] = await Promise.all([
    import('../server/routes/search.js'),
    import('../server/db/queries.js'),
    import('../server/db/projects.js'),
    import('../server/db/index.js'),
  ]);

  const project = projects.createProject({
    name: 'Cross-profile search project',
    purpose: 'Verify ACL-scoped multi-profile task search',
    managerProfileId: 'default',
    changedBy: 'test',
  });
  projects.grantProjectProfileAccess({
    projectId: project.id,
    profileId: 'writer',
    role: 'view',
    grantedBy: 'default',
  });

  const defaultTask = queries.insertTask({
    title: 'Beta metadata secret',
    description: 'Only the default profile may find betametadatasecret',
    status: 'in_progress',
    profile_name: null,
    project_id: project.id,
  });
  const writerTask = queries.insertTask({
    title: 'Alpha metadata',
    description: 'Only writer may find alphametadatasecret',
    status: 'in_progress',
    profile_name: 'writer',
    project_id: project.id,
  });

  await mkdir(dirname(join(hermesHome, 'state.db')), { recursive: true });
  createHermesState(join(hermesHome, 'state.db'), defaultTask.id, 'betamessagesecret belongs to default');
  createHermesState(join(writerHome, 'state.db'), writerTask.id, 'alphamessagesecret belongs to writer');

  const app = express();
  app.use('/api/search', searchRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    assert.deepEqual(
      (await search(base, 'alphametadatasecret', 'writer')).map((result) => [result.taskId, result.role]),
      [[writerTask.id, 'task']],
      'profile search returns its own task metadata',
    );
    assert.deepEqual(
      (await search(base, 'alphamessagesecret', 'writer')).map((result) => [result.taskId, result.role]),
      [[writerTask.id, 'user']],
      'profile message search reads its own Hermes state database',
    );
    assert.deepEqual(await search(base, 'betametadatasecret', 'writer'), [],
      'profile A cannot obtain profile B task metadata');
    assert.deepEqual(await search(base, 'betamessagesecret', 'writer'), [],
      'profile A cannot obtain profile B message search results');

    assert.deepEqual(
      (await search(base, 'betametadatasecret')).map((result) => [result.taskId, result.role]),
      [[defaultTask.id, 'task']],
      'omitting profile preserves legacy default task search behavior',
    );
    assert.deepEqual(
      (await search(base, 'betamessagesecret')).map((result) => [result.taskId, result.role]),
      [[defaultTask.id, 'user']],
      'omitting profile preserves legacy default message search behavior',
    );
    assert.deepEqual(
      (await search(base, 'belongs', 'writer', project.id))
        .map((result) => [result.taskId, result.handlingProfileId, result.role])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        [defaultTask.id, 'default', 'user'],
        [writerTask.id, 'writer', 'user'],
      ].sort((left, right) => left[0].localeCompare(right[0])),
      'authorized Project search spans only the Project tasks across immutable handler databases',
    );
    const denied = await fetch(`${base}/api/search?${new URLSearchParams({
      q: 'belongs', profile: 'reviewer', projectId: project.id,
    })}`);
    assert.equal(denied.status, 404);
    assert.equal((await denied.json() as { code: string }).code, 'PROJECT_NOT_FOUND');
  } finally {
    server.close();
    await once(server, 'close');
    dispatchDb.close();
  }
} finally {
  if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousHermesHome;
  if (previousDispatchHome === undefined) delete process.env.OLYMPUS_DISPATCH_HOME;
  else process.env.OLYMPUS_DISPATCH_HOME = previousDispatchHome;
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
  await rm(root, { recursive: true, force: true });
}

console.log('Profile-scoped search isolation tests passed');
