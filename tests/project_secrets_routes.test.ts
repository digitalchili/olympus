import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
const root = await mkdtemp(join(tmpdir(), 'olympus-secrets-routes-'));
process.env.DB_PATH = join(root, 'test.db'); process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state'); process.env.HERMES_HOME = join(root, 'hermes');
for (const profile of ['', 'profiles/viewer']) {
  await mkdir(join(process.env.HERMES_HOME, profile), { recursive: true });
  await writeFile(join(process.env.HERMES_HOME, profile, 'config.yaml'), '{}\n');
  if (profile) await writeFile(join(process.env.HERMES_HOME, profile, 'profile.yaml'), 'display_name: Viewer\n');
}
const { createProjectSecretsRouter } = await import('../server/routes/project-secrets.js');
const { createProject, grantProjectProfileAccess } = await import('../server/db/projects.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { claimProjectConfigurationOperation } = await import('../server/task-run-lifecycle.js');
const { default: db } = await import('../server/db/index.js');
const project = createProject({ name: 'Secrets', purpose: 'test', managerProfileId: 'default', changedBy: 'test' });
const other = createProject({ name: 'Other', purpose: 'test', managerProfileId: 'default', changedBy: 'test' });
grantProjectProfileAccess({ projectId: project.id, profileId: 'viewer', role: 'view', grantedBy: 'test' });
const task = insertTask({ title: 'Bound task', status: 'in_progress', project_id: project.id });
const inbox = insertTask({ title: 'Inbox task', status: 'in_progress' });
const app = express(); app.use(express.json()); app.use('/api/projects', createProjectSecretsRouter());
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const value = 'synthetic-private-value-not-real';
const entries = [{ name: 'API_KEY', value }];
async function call(path = project.id + '/secrets', method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/projects/${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Olympus-Secret-Entry': '1', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text(); assert.equal(text.includes(value), false, 'HTTP responses never contain values');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
try {
  assert.equal((await call(undefined, 'PUT', { entries, taskId: task.id }, { Origin: base })).status, 200);
  assert.deepEqual((await call()).body.secrets.map((secret: any) => secret.name), ['API_KEY']);
  assert.deepEqual((await call(undefined, 'PUT', { entries })).body.savedNames, ['API_KEY']);
  assert.equal((await call(undefined, 'PUT', { entries }, { 'X-Olympus-Secret-Entry': '' })).status, 403);
  assert.equal((await call(undefined, 'PUT', { entries }, { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await call(undefined, 'PUT', { entries }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call(project.id + '/secrets?profile=viewer')).status, 200);
  assert.equal((await call(project.id + '/secrets?profile=viewer', 'PUT', { entries })).status, 404);
  assert.equal((await call(project.id + '/secrets/API_KEY?profile=viewer', 'DELETE')).status, 404);
  assert.equal((await call(other.id + '/secrets', 'PUT', { entries, taskId: task.id })).status, 409);
  assert.equal((await call(undefined, 'PUT', { entries, taskId: 'missing' })).status, 404);
  assert.equal((await call(undefined, 'PUT', { entries, taskId: inbox.id })).status, 200);
  assert.equal(getTask(inbox.id)?.project_id, null, 'saving to a project does not reassign an Inbox task');
  assert.equal((await call(undefined, 'PUT', { entries: [{ name: 'API_KEY', value: '' }] })).status, 400);
  const release = claimProjectConfigurationOperation(project.id); assert.ok(release);
  assert.equal((await call(undefined, 'PUT', { entries })).status, 409); release();
  assert.equal((await call(project.id + '/secrets/API_KEY', 'DELETE')).status, 204);
  assert.deepEqual((await call()).body.secrets, []);
} finally { server.close(); await once(server, 'close'); db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Project secret API scope, names-only responses, same-origin writes and mutation fencing passed');
