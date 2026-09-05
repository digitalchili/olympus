import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AgentAdapter } from '../server/adapters/types.js';
import type { InteractionResponse, NativeInteraction } from '../shared/interactions.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-interactions-routes-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
await mkdir(join(hermesHome, 'profiles', 'writer'), { recursive: true });
await writeFile(join(hermesHome, 'profile.yaml'), 'displayName: Default\nactive: true\n');
await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
await writeFile(join(hermesHome, 'profiles', 'writer', 'profile.yaml'), 'displayName: Writer\nactive: true\n');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'interactions.db');

const [{ insertTask }, { startRun, discardRun, getRunStatus }, interactionDb, { createInteractionRouter }, { profileTaskRequestGate }, { default: db }] = await Promise.all([
  import('../server/db/queries.js'),
  import('../server/live-chat.js'),
  import('../server/db/interactions.js'),
  import('../server/routes/interactions.js'),
  import('../server/profile-context.js'),
  import('../server/db/index.js'),
]);

const delivered: Array<{ taskId: string; interactionId: string; workerRunId: string; response: InteractionResponse }> = [];
const adapter = {
  async respondInteraction(request: { taskId: string; interactionId: string; workerRunId: string; response: InteractionResponse }) {
    delivered.push(request);
    // The native tool thread may settle before the respond RPC acknowledges.
    assert.deepEqual(interactionDb.getInteraction(request.interactionId)?.response, request.response,
      'response is durably saved before any worker delivery');
    interactionDb.markInteractionSettled(request.interactionId, 'answered');
    return { accepted: true as const };
  },
} as AgentAdapter;

const app = express();
app.use(express.json());
app.use('/api/tasks', profileTaskRequestGate());
app.use('/api/tasks', createInteractionRouter(adapter));
app.use('/unsupported/api/tasks', createInteractionRouter({} as AgentAdapter));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function payload(id: string, workerRunId: string, expiresAt = Date.now() + 60_000): NativeInteraction {
  return {
    id,
    workerRunId,
    kind: 'clarification',
    title: 'Need details',
    questions: [
      { id: 'q1', question: 'Pick one', choices: ['A', 'B'], multiSelect: false },
      { id: 'q2', question: 'Pick many', choices: ['red', 'blue'], multiSelect: true },
    ],
    expiresAt,
  };
}

try {
  const task = insertTask({ title: 'Default interaction task', status: 'in_progress', profile_name: 'default' });
  const writerTask = insertTask({ title: 'Writer interaction task', status: 'in_progress', profile_name: 'writer', handling_profile_id: 'writer' });
  startRun(task.id, task.id, 'hello');
  const olympusRunId = getRunStatus(task.id)!.runId;
  interactionDb.recordInteraction({
    taskId: task.id,
    profileName: 'default',
    olympusRunId,
    interaction: payload('clarify-1', 'worker-1'),
  });

  const list = await (await fetch(`${base}/api/tasks/${task.id}/interactions?profile=default`)).json() as { interactions: NativeInteraction[] };
  assert.equal(list.interactions.length, 1, 'reload lists durable pending interactions');
  assert.equal(list.interactions[0]!.id, 'clarify-1');

  const crossProfile = await fetch(`${base}/api/tasks/${task.id}/interactions?profile=writer`);
  assert.equal(crossProfile.status, 404, 'profile-scoped routes hide other profiles tasks');

  const invalidExtra = await fetch(`${base}/api/tasks/${task.id}/interactions/clarify-1/respond?profile=default`, json('POST', {
    workerRunId: 'worker-1',
    response: { answers: { q1: 'A', q2: ['red'] } },
    extra: true,
  }));
  assert.equal(invalidExtra.status, 400);

  const invalidProto = await fetch(`${base}/api/tasks/${task.id}/interactions/clarify-1/respond?profile=default`, json('POST', '{"workerRunId":"worker-1","response":{"answers":{"q1":"A","q2":["red"],"__proto__":"pollute"}}}'));
  assert.equal(invalidProto.status, 400, 'unsafe prototype-like answer keys are rejected');

  const valid = await fetch(`${base}/api/tasks/${task.id}/interactions/clarify-1/respond?profile=default`, json('POST', {
    workerRunId: 'worker-1',
    response: { answers: { q1: 'Other bounded text', q2: ['red', 'custom free text'] } },
  }));
  const validBody = await valid.json().catch(() => ({}));
  assert.equal(valid.status, 200, JSON.stringify(validBody));
  assert.deepEqual(validBody, { accepted: true });
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    taskId: task.id,
    interactionId: 'clarify-1',
    workerRunId: 'worker-1',
    response: { answers: { q1: 'Other bounded text', q2: ['red', 'custom free text'] } },
  });
  assert.equal(interactionDb.getInteraction('clarify-1')?.status, 'answered');
  assert.deepEqual(interactionDb.getInteraction('clarify-1')?.response, delivered[0]?.response, 'early native settlement cannot lose the submitted answers');

  const replay = await fetch(`${base}/api/tasks/${task.id}/interactions/clarify-1/respond?profile=default`, json('POST', {
    workerRunId: 'worker-1',
    response: { answers: { q1: 'A', q2: ['red'] } },
  }));
  assert.equal(replay.status, 409, 'replay cannot deliver a second response');

  interactionDb.recordInteraction({
    taskId: task.id,
    profileName: 'default',
    olympusRunId,
    interaction: payload('expired-1', 'worker-expired', Date.now() - 1),
  });
  assert.equal((await fetch(`${base}/api/tasks/${task.id}/interactions/expired-1/respond?profile=default`, json('POST', {
    workerRunId: 'worker-expired',
    response: { answers: { q1: 'A', q2: ['red'] } },
  }))).status, 409, 'expired interactions are stale');
  assert.equal(interactionDb.getInteraction('expired-1')?.status, 'expired');

  startRun(writerTask.id, writerTask.id, 'writer');
  interactionDb.recordInteraction({
    taskId: writerTask.id,
    profileName: 'writer',
    olympusRunId: getRunStatus(writerTask.id)!.runId,
    interaction: payload('restart-1', 'worker-restart'),
  });
  interactionDb.recoverInterruptedInteractions(12345);
  assert.equal(interactionDb.getInteraction('restart-1')?.status, 'cancelled', 'restart retains but closes waiting records');

  interactionDb.recordInteraction({
    taskId: task.id,
    profileName: 'default',
    olympusRunId,
    interaction: payload('unsupported-1', 'worker-unsupported'),
  });
  const unsupported = await fetch(`${base}/unsupported/api/tasks/${task.id}/interactions/unsupported-1/respond?profile=default`, json('POST', {
    workerRunId: 'worker-unsupported',
    response: { answers: { q1: 'A', q2: ['red'] } },
  }));
  assert.equal(unsupported.status, 503, 'adapters without native interaction support fail safely');
  assert.equal(interactionDb.getInteraction('unsupported-1')?.status, 'waiting');

  // A long answered history must not hide a pending callback.
  interactionDb.recordInteraction({taskId: task.id, profileName: 'default', olympusRunId,
    interaction: payload('old-pending', 'worker-1'), requestedAt: Date.now() - 1000});
  for (let i = 0; i < 25; i++) {
    const id = `history-${i}`;
    interactionDb.recordInteraction({taskId: task.id, profileName: 'default', olympusRunId,
      interaction: payload(id, 'worker-1')});
    interactionDb.markInteractionSettled(id, 'answered');
  }
  assert.ok(interactionDb.listTaskInteractions(task.id, 'default').some(i => i.id === 'old-pending'),
    'pending questions stay visible beyond the recent-history limit');
  assert.equal(interactionDb.hasUnansweredInteractions(task.id, olympusRunId), true);
  interactionDb.closeRunInteractions(task.id, olympusRunId);
  assert.equal(interactionDb.getInteraction('old-pending')?.status, 'cancelled', 'worker loss closes pending callbacks');
  assert.equal(interactionDb.hasUnansweredInteractions(task.id, olympusRunId), true, 'unanswered run cannot be promoted for review');
  assert.equal(interactionDb.hasUnansweredInteractions(task.id, 'new-run'), false, 'old cancelled questions do not block a fresh run');
  discardRun(task.id);
  discardRun(writerTask.id);
} finally {
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('interaction route tests passed');
