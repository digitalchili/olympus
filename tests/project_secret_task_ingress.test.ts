import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'secret-task-ingress-'));
process.env.HERMES_HOME = join(root, 'hermes'); process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state'); process.env.DB_PATH = join(root, 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true }); await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
let titles = 0; adapter.generateTitle = async () => { titles++; return { title: 'Title' }; };
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const secret = 'API_KEY=example-from-documentation';
try {
  for (const extra of [{ description: secret }, { title: secret }, { initialMessage: { content: secret } }]) {
    const response = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Safe task', title: 'Safe title', ...extra }) });
    assert.equal(response.status, 201, await response.clone().text());
    const { task } = await response.json();
    if ('description' in extra) assert.equal(task.description, secret);
    if ('title' in extra) assert.equal(task.title, secret);
    if ('initialMessage' in extra) assert.equal((db.prepare('SELECT content FROM task_message_queue WHERE task_id = ?').get(task.id) as any).content, secret);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as any).count, 3);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM task_message_queue').get() as any).count, 1);
  assert.equal(titles, 0);
  const task = insertTask({ title: 'Safe task', status: 'in_progress' });
  for (const suffix of ['', '/']) {
    const edited = await fetch(base + '/api/tasks/' + task.id + suffix, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: secret }) });
    assert.equal(edited.status, 200); assert.equal(getTask(task.id)?.description, secret);
  }
  const malformed = await fetch(base + '/api/projects/unused/secrets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"value":"synthetic-must-not-enter-history" broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes('synthetic-must-not-enter-history'), false, 'JSON parser errors never echo values');
} finally { server.close(); await once(server, 'close'); db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Task text stays ordinary text; explicit secret-entry JSON errors remain sanitized');
