import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-steer-routes-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'dispatch');
process.env.DB_PATH = join(root, 'test.db');
const profile = 'audio-profile';
for (const home of [process.env.HERMES_HOME, join(process.env.HERMES_HOME, 'profiles', profile)]) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), '{}\n');
  await writeFile(join(home, 'profile.yaml'), 'displayName: Audio\nactive: true\n');
}
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { startRun, getRun, discardRun } = await import('../server/live-chat.js');
const { putQueuedTaskMessage, getQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const task = insertTask({ title: 'Audio steer', status: 'in_progress', profile_name: profile });
const content = 'Apply the review in this pasted document.\n\n[Attached files:\n- ~/.olympus-dispatch/workspace/uploads/clipboard-paste.txt]';
putQueuedTaskMessage({
  id: 'audio-follow-up', taskId: task.id, content, settings: {}, invitedProfileIds: [],
  collaborationScope: 'discussion', confirmPersistentCollaboration: false,
  createdAt: Date.now(), updatedAt: Date.now(),
});
startRun(task.id, task.id, 'Make an audio preview');
const delivered: Array<{ sessionId: string; content: string }> = [];
let accepting = true;
adapter.steerChat = async (sessionId, message) => {
  if (accepting) delivered.push({ sessionId, content: message });
  return accepting;
};
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/api/tasks/${task.id}/steer`;
const steer = (selectedProfile: string, message = content) => fetch(`${url}?profile=${selectedProfile}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }),
});
try {
  const wrongProfile = await steer('default');
  assert.equal(wrongProfile.status, 404, 'steering remains scoped to the task profile');
  assert.equal(delivered.length, 0);

  const response = await steer(profile);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { steered: true, queued: false }, 'uploaded file references must reach the running agent');
  assert.deepEqual(delivered, [{ sessionId: task.id, content }], 'the steer retains both the direction and the attachment path');
  assert.equal(getRun(task.id)!.messages.filter(message => message.role === 'user').at(-1)!.content, content);
  assert.equal(getRun(task.id)!.status, 'streaming', 'steering does not interrupt active work');

  for (const message of [
    'Compare this mix.\n\n[Attached files:\n- ~/.olympus-dispatch/workspace/uploads/mix.mp3]',
    'Use this reference.\n\n[Attached files:\n- ~/.olympus-dispatch/workspace/uploads/design.png]',
    'Change direction without an attachment.',
  ]) {
    assert.deepEqual(await (await steer(profile, message)).json(), { steered: true, queued: false });
    assert.equal(delivered.at(-1)!.content, message);
  }

  accepting = false;
  const before = getRun(task.id)!.messages.length;
  const declined = await steer(profile);
  assert.deepEqual(await declined.json(), { steered: false, queued: true });
  assert.equal(getQueuedTaskMessage(task.id)!.content, content, 'an unavailable agent must leave the full follow-up saved');
  assert.equal(getRun(task.id)!.messages.length, before, 'declined steers are not displayed as delivered');

  discardRun(task.id);
  assert.equal((await steer(profile)).status, 409, 'a finished run uses the existing normal follow-up fallback');
} finally {
  discardRun(task.id);
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Attachment steering route tests passed');
