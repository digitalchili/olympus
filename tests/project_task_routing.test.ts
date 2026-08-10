import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-task-routing-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'tasks.db');

async function profile(id: string, name: string, active = true) {
  const home = id === 'default' ? hermesHome : join(hermesHome, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'profile.yaml'), `displayName: ${name}\nactive: ${active}\n`);
  await writeFile(join(home, 'config.yaml'), '{}\n');
}

await profile('default', 'Somboon');
await profile('studio', 'Somboon Studio');
await profile('claude-manager', 'Claude Manager');
await profile('inactive', 'Inactive', false);

const { default: app } = await import('../server/app.js');
const { createProject, reassignProject } = await import('../server/db/projects.js');
const { default: db } = await import('../server/db/index.js');
const project = createProject({
  name: 'Olympus Preview QA',
  purpose: 'Development and operation of Olympus Preview QA',
  managerProfileId: 'studio',
  changedBy: 'local-user',
}, 1_000);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const postTask = async (query: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/tasks${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: typeof body.description === 'string' ? body.description : 'Test task',
        ...body,
      }),
    });
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  };

  const projectTaskResponse = await postTask('?profile=studio', {
    description: 'Design settlement reconciliation',
    projectId: project.id,
  });
  assert.equal(projectTaskResponse.status, 201);
  const firstProjectTask = projectTaskResponse.body.task as Record<string, unknown>;
  assert.equal(firstProjectTask.project_id, project.id);
  assert.equal(firstProjectTask.handling_profile_id, 'studio');
  assert.equal(firstProjectTask.profile_name, 'studio');
  assert.equal(firstProjectTask.delegated_worker_id, null);

  const unrelatedProjectCreate = await postTask('?profile=default', {
    description: 'Unauthorized Project task',
    projectId: project.id,
  });
  assert.equal(unrelatedProjectCreate.status, 404);

  const conflicting = await postTask('?profile=studio', {
    description: 'Route this incorrectly',
    projectId: project.id,
    handlingProfileId: 'default',
  });
  assert.equal(conflicting.status, 400);
  assert.equal(conflicting.body.code, 'PROJECT_HANDLER_DERIVED');

  const missingProject = await postTask('?profile=default', {
    description: 'Missing location',
    projectId: 'missing',
  });
  assert.equal(missingProject.status, 404);

  const inboxResponse = await postTask('?profile=default', {
    description: 'Standalone Claude task',
    handlingProfileId: 'claude-manager',
  });
  assert.equal(inboxResponse.status, 201);
  const inboxTask = inboxResponse.body.task as Record<string, unknown>;
  assert.equal(inboxTask.project_id, null);
  assert.equal(inboxTask.handling_profile_id, 'claude-manager');
  assert.equal(inboxTask.profile_name, 'claude-manager');

  const inactive = await postTask('?profile=default', {
    description: 'Must fail closed',
    handlingProfileId: 'inactive',
  });
  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.code, 'INACTIVE_PROFILE');

  const legacyInboxResponse = await postTask('?profile=studio', {
    description: 'Legacy client fallback',
  });
  assert.equal(legacyInboxResponse.status, 201);
  const legacyInboxTask = legacyInboxResponse.body.task as Record<string, unknown>;
  assert.equal(legacyInboxTask.project_id, null);
  assert.equal(legacyInboxTask.handling_profile_id, 'studio');

  reassignProject({
    projectId: project.id,
    managerProfileId: 'claude-manager',
    changedBy: 'local-user',
  }, 2_000);

  const oldManagerAfterReassign = await postTask('?profile=studio', {
    description: 'Old manager cannot create future Project work',
    projectId: project.id,
  });
  assert.equal(oldManagerAfterReassign.status, 404);

  const secondProjectTaskResponse = await postTask('?profile=claude-manager', {
    description: 'New task after manager change',
    projectId: project.id,
  });
  assert.equal(secondProjectTaskResponse.status, 201);
  const secondProjectTask = secondProjectTaskResponse.body.task as Record<string, unknown>;
  assert.equal(secondProjectTask.handling_profile_id, 'claude-manager');

  const oldTaskResponse = await fetch(`${base}/api/tasks/${firstProjectTask.id}?profile=studio`);
  assert.equal(oldTaskResponse.status, 200, 'historic task remains with its original handler');
  assert.equal((await fetch(`${base}/api/tasks/${firstProjectTask.id}?profile=claude-manager`)).status, 404);
  assert.equal((await fetch(`${base}/api/tasks/${secondProjectTask.id}?profile=claude-manager`)).status, 200);
  assert.equal((await fetch(`${base}/api/tasks/${secondProjectTask.id}?profile=studio`)).status, 404);

  assert.equal((await fetch(`${base}/api/projects/${project.id}/tasks?profile=default`)).status, 404);
  const projectTasksResponse = await fetch(`${base}/api/projects/${project.id}/tasks`);
  assert.equal(projectTasksResponse.status, 200);
  const projectTasks = (await projectTasksResponse.json() as { tasks: Array<Record<string, unknown>> }).tasks;
  assert.deepEqual(
    projectTasks.map((task) => task.id).sort(),
    [firstProjectTask.id, secondProjectTask.id].sort(),
  );
  assert.equal(projectTasks.some((task) => task.id === inboxTask.id), false);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/tasks?profile=claude-manager`)).status, 200);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Project and Inbox task routing tests passed');
