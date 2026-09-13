import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

await mkdir(process.env.HERMES_HOME!, { recursive: true });
await writeFile(join(process.env.HERMES_HOME!, 'config.yaml'), '{}\n');
const { default: app } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const protectedTask = insertTask({ title: 'Protected history', status: 'in_review' });
db.exec(`
  CREATE TABLE legacy_task_control_events (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE TRIGGER legacy_control_event_immutable BEFORE DELETE ON legacy_task_control_events
  BEGIN SELECT RAISE(ABORT, 'TASK_CONTROL_EVENT_IMMUTABLE'); END;
  CREATE TRIGGER legacy_not_releasable BEFORE UPDATE OF status ON tasks
  WHEN NEW.status = 'done' AND EXISTS (SELECT 1 FROM legacy_task_control_events WHERE task_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'TASK_NOT_RELEASABLE'); END;
`);
db.prepare('INSERT INTO legacy_task_control_events VALUES (?, ?)').run('event-1', protectedTask.id);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/tasks`;
try {
  for (const [method, suffix, code] of [
    ['PATCH', '', 'TASK_NOT_RELEASABLE'],
    ['POST', '/move', 'TASK_NOT_RELEASABLE'],
    ['DELETE', '', 'TASK_CONTROL_EVENT_IMMUTABLE'],
  ]) {
    const response = await fetch(`${base}/${protectedTask.id}${suffix}?profile=default`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(method === 'DELETE' ? {} : { body: JSON.stringify({ status: 'done' }) }),
    });
    assert.equal(response.status, 409, `${method} must report a conflict without crashing`);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.match(body.error, /history|approval/i);
    assert.equal(getTask(protectedTask.id)?.status, 'in_review');
    assert.equal(db.prepare('SELECT count(*) AS n FROM legacy_task_control_events').get().n, 1);
  }
  const ordinary = insertTask({ title: 'Ordinary task', status: 'in_review' });
  const moved = await fetch(`${base}/${ordinary.id}/move?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(moved.status, 200);
  assert.equal(getTask(ordinary.id)?.status, 'done');
  assert.equal((await fetch(`${base}/${ordinary.id}?profile=default`, { method: 'DELETE' })).status, 200);
  assert.equal(getTask(ordinary.id), undefined);
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
}
console.log('Task mutation conflicts preserve history and keep the server available');
