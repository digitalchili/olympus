import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-cp-lifecycle-'));
const hermesHome = join(root, 'hermes');
const writerHome = join(hermesHome, 'profiles', 'writer');
const dispatchHome = join(root, 'dispatch');
const previousHermesHome = process.env.HERMES_HOME;
const previousDispatchHome = process.env.OLYMPUS_DISPATCH_HOME;
const previousDbPath = process.env.DB_PATH;

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

try {
  await mkdir(writerHome, { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
  await writeFile(join(writerHome, 'profile.yaml'), 'displayName: Writer\n');
  await writeFile(join(writerHome, 'config.yaml'), '{}\n');
  process.env.HERMES_HOME = hermesHome;
  process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
  process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

  const [
    { default: app },
    { createProject },
    { insertTask },
    { acquireProjectEditor },
    { default: db },
  ] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/projects.js'),
    import('../server/db/queries.js'),
    import('../server/db/project-cp.js'),
    import('../server/db/index.js'),
  ]);

  const defaultProject = createProject({
    name: 'Default editor deletion guard', purpose: 'Keep an active editor recoverable', managerProfileId: 'default', changedBy: 'test',
  });
  const defaultTask = insertTask({
    title: 'Default editor', status: 'in_progress', project_id: defaultProject.id, handling_profile_id: 'default', profile_name: 'default',
  });
  acquireProjectEditor({
    projectId: defaultProject.id, taskId: defaultTask.id, profileId: 'default', repositoryFullName: 'example/default',
    baseBranch: 'main', branchName: 'olympus/default', workdir: join(root, 'managed', defaultProject.id),
    baseSha: 'a'.repeat(40), leaseToken: 'default-lease',
  });

  const writerProject = createProject({
    name: 'Writer editor deletion guard', purpose: 'Keep profile-owned editor recoverable', managerProfileId: 'default', changedBy: 'test',
  });
  const writerTask = insertTask({
    title: 'Writer editor', status: 'in_progress', project_id: writerProject.id, handling_profile_id: 'writer', profile_name: 'writer',
  });
  acquireProjectEditor({
    projectId: writerProject.id, taskId: writerTask.id, profileId: 'writer', repositoryFullName: 'example/writer',
    baseBranch: 'main', branchName: 'olympus/writer', workdir: join(root, 'managed', writerProject.id),
    baseSha: 'b'.repeat(40), leaseToken: 'writer-lease',
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const taskDelete = await fetch(`${base}/api/tasks/${defaultTask.id}`, jsonRequest('DELETE'));
    assert.equal(taskDelete.status, 409);
    assert.equal((await taskDelete.json()).code, 'PROJECT_EDITOR_ACTIVE');

    const profileDelete = await fetch(`${base}/api/profiles/writer?profile=default`, jsonRequest('DELETE', { confirmation: 'writer' }));
    assert.equal(profileDelete.status, 409);
    assert.equal((await profileDelete.json()).code, 'PROJECT_EDITOR_ACTIVE');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
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

console.log('Project CP lifecycle route tests passed');
