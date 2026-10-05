import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-late-steer-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
await mkdir(join(process.env.HERMES_HOME, 'profiles', 'reviewer'), { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'profiles', 'reviewer', 'profile.yaml'), 'displayName: Reviewer\nactive: true\n');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { getRun, discardRun } = await import('../server/live-chat.js');
const { getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
const { listCollaborationRuns } = await import('../server/db/collaboration.js');
const { getQueuedTaskMessage, putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
const ids: string[] = [];
const post = (id: string, route: string, body: object) => fetch(`${base}/${id}/${route}?profile=default`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'Expected run state was not reached');
};
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.getMessages = async () => [];
adapter.setGoal = async () => ({ goal: 'Inspect screenshots', status: 'active', turnsUsed: 0, maxTurns: 0 });
try {
  for (const mode of ['task', 'goal', 'collaboration'] as const) {
    const task = insertTask({ title: `Late attachment in ${mode}`, status: 'in_progress' });
    ids.push(task.id);
    const content = `Here\n\n[Attached files:\n- ${join(root, 'new-screenshot.jpg')}]`;
    let releaseFinal!: () => void;
    const finalReady = new Promise<void>(resolve => { releaseFinal = resolve; });
    let releaseFollowup!: () => void;
    const followupReady = new Promise<void>(resolve => { releaseFollowup = resolve; });
    const calls: string[] = [];
    let contributors = 0;
    adapter.chatForProfile = async () => { contributors++; return { text: 'Advisory response' }; };
    let evaluations = 0;
    adapter.evaluateGoal = async () => {
      evaluations++;
      assert.equal(calls.length, 2, 'A pending attachment is handled before evaluating completion');
      return { status: 'done', shouldContinue: false, verdict: 'done', reason: 'finished', message: '' };
    };
    adapter.steerChat = async (sessionId, message) => {
      assert.equal(sessionId, task.id);
      assert.equal(message, content);
      releaseFinal();
      return true;
    };
    adapter.chatStream = async function* (sessionId, message) {
      assert.equal(sessionId, task.id, 'Continuation stays in the same task and session');
      calls.push(message);
      if (calls.length === 1) {
        yield { type: 'text_delta', content: 'Previous answer' };
        await finalReady;
        yield { type: 'done', sessionId, pendingSteer: content };
      } else {
        assert.equal(message, content, 'The normal follow-up receives the complete image footer');
        await followupReady;
        yield { type: 'text_delta', content: 'New screenshot handled' };
        yield { type: 'done', sessionId };
      }
    };
    assert.equal((await post(task.id, 'messages', {
      content: 'Original request', settings: { mode: mode === 'goal' ? 'goal' : 'task' },
      ...(mode === 'collaboration' ? { invitedProfileIds: ['reviewer'] } : {}),
    })).status, 202);
    await waitFor(() => calls.length === 1);
    assert.deepEqual(await (await post(task.id, 'steer', { content })).json(), { steered: true, queued: false });
    await waitFor(() => calls.length === 2);
    assert.equal(getTask(task.id)?.status, 'in_progress', 'A late steer must not prematurely move the task to review');
    assert.equal(getRun(task.id)?.status, 'streaming');
    releaseFollowup();
    await waitFor(() => getLatestTaskAgentRun(task.id)?.status === 'done');
    assert.equal(calls.length, 2, 'No dropped or repeated follow-up');
    assert.equal(evaluations, mode === 'goal' ? 1 : 0);
    if (mode === 'collaboration') {
      assert.equal(contributors, 1, 'A late steer continues the chair without repeating contributors');
      assert.equal(listCollaborationRuns(task.id)[0]?.status, 'completed');
    }
    assert.equal(getTask(task.id)?.status, 'in_review');
    assert.equal(getRun(task.id)?.messages.filter(message => message.role === 'user' && message.content === content).length, 1);
  }
  for (const queueState of ['none', 'newer', 'original'] as const) {
    const task = insertTask({ title: 'Failed child with pending attachment', status: 'in_progress' });
    ids.push(task.id);
    const content = `Here\n\n[Attached files:\n- ${join(root, 'pending.png')}]`;
    let releaseFinal!: () => void;
    const finalReady = new Promise<void>(resolve => { releaseFinal = resolve; });
    let calls = 0;
    adapter.steerChat = async () => { releaseFinal(); return true; };
    adapter.chatStream = async function* () {
      calls++;
      await finalReady;
      if (queueState !== 'none') putQueuedTaskMessage({
        id: 'prior-queue', taskId: task.id, content: queueState === 'original' ? content : 'Also check the mobile layout',
        settings: { mode: 'task' }, invitedProfileIds: [], collaborationScope: 'discussion',
        confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1,
      });
      // Errors terminate the worker transport: the pending message must travel
      // on the error itself, rather than a subsequent done event.
      yield { type: 'error', error: 'Child synthesis failed', code: 'agent_failed', pendingSteer: content };
    };
    assert.equal((await post(task.id, 'messages', { content: 'Original request' })).status, 202);
    await waitFor(() => calls === 1);
    assert.equal((await post(task.id, 'steer', { content })).status, 200);
    await waitFor(() => getLatestTaskAgentRun(task.id)?.status === 'error');
    assert.equal(calls, 1, 'A failed run never automatically restarts to deliver the steer');
    assert.equal(getTask(task.id)?.status, 'in_progress');
    assert.equal(getQueuedTaskMessage(task.id)?.content, content + (queueState === 'newer' ? '\n\nAlso check the mobile layout' : ''));
    assert.notEqual(getQueuedTaskMessage(task.id)?.id, 'prior-queue', 'A stale browser cannot erase the restored message');
    assert.equal((await fetch(`${base}/${task.id}/queued-message/prior-queue?profile=default`, { method: 'DELETE' })).status, 409);
    const saved = await (await fetch(`${base}/${task.id}/queued-message?profile=default`)).json();
    assert.equal(saved.queuedMessage.content, getQueuedTaskMessage(task.id)?.content, 'Pending attachment remains available after reload');
  }
} finally {
  for (const id of ids) discardRun(id);
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Late attachments continue in Task, Goal and collaboration, and stay queued on failure');
