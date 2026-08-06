import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent } from '../server/adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-task-deletion-lifecycle-'));
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

function fakeResponse() {
  let ended = false;
  return {
    get ended() { return ended; },
    write() { return true; },
    end() { ended = true; },
    on() { return this; },
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
    { default: app, adapter },
    queries,
    liveChat,
    collaborationDb,
    taskRunLifecycle,
    { default: db },
  ] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/queries.js'),
    import('../server/live-chat.js'),
    import('../server/db/collaboration.js'),
    import('../server/task-run-lifecycle.js'),
    import('../server/db/index.js'),
  ]);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const originalChatStream = adapter.chatStream;
  const originalInterruptChat = adapter.interruptChat;
  const originalSetGoal = adapter.setGoal;
  const originalEvaluateGoal = adapter.evaluateGoal;
  const originalCompressSession = adapter.compressSession;
  const originalGetMessages = adapter.getMessages;
  const originalChatForProfile = adapter.chatForProfile;
  const originalInterruptChatForProfile = adapter.interruptChatForProfile;

  try {
    for (const mode of ['task', 'goal'] as const) {
      const task = queries.insertTask({
        title: `Active ${mode} deletion`,
        status: 'in_progress',
        profile_name: 'default',
      });
      const subscriber = fakeResponse();
      liveChat.subscribe(task.id, subscriber as never);

      let releaseStream!: () => void;
      const streamBlocked = new Promise<void>((resolve) => { releaseStream = resolve; });
      let markStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => { markStreamStarted = resolve; });
      let streamSettled = false;
      let interruptSawTask = false;

      adapter.setGoal = async () => ({
        goal: 'delete safely',
        status: 'running',
        turnCount: 0,
        maxTurns: 10,
      } as never);
      adapter.chatStream = async function* (sessionId): AsyncIterable<StreamEvent> {
        markStreamStarted();
        try {
          await streamBlocked;
          yield { type: 'done', sessionId, interrupted: true, context: null };
        } finally {
          streamSettled = true;
          assert.ok(queries.getTask(task.id), 'task row must survive until its detached worker stream settles');
        }
      };
      adapter.interruptChat = async (sessionId, reason) => {
        assert.equal(sessionId, task.id);
        assert.equal(reason, 'Task deleted');
        interruptSawTask = queries.getTask(task.id) !== undefined;
        releaseStream();
        return true;
      };

      const runResponse = await fetch(`${base}/api/tasks/${task.id}/messages`, jsonRequest('POST', {
        content: `start ${mode}`,
        mode,
      }));
      assert.equal(runResponse.status, 202);
      await runResponse.json();
      await streamStarted;

      const deleteResponse = await fetch(`${base}/api/tasks/${task.id}`, jsonRequest('DELETE'));
      assert.equal(deleteResponse.status, 200);
      assert.equal(interruptSawTask, true, `${mode} worker must be cancelled before deleting its task row`);
      assert.equal(streamSettled, true, `${mode} worker stream must not survive task deletion`);
      assert.equal(queries.getTask(task.id), undefined);
      assert.equal(liveChat.getRun(task.id), undefined, `${mode} live state must be discarded`);
      assert.equal(subscriber.ended, true, `${mode} SSE subscribers must be closed`);
    }

    const goalSetupTask = queries.insertTask({
      title: 'Delete during named-profile goal setup',
      status: 'in_progress',
      profile_name: 'writer',
    });
    let releaseGoalSetup!: () => void;
    const goalSetupBlocked = new Promise<void>((resolve) => { releaseGoalSetup = resolve; });
    let markGoalSetupStarted!: () => void;
    const goalSetupStarted = new Promise<void>((resolve) => { markGoalSetupStarted = resolve; });
    let goalStreamSawTask = false;

    adapter.setGoal = async () => {
      markGoalSetupStarted();
      await goalSetupBlocked;
      return {
        goal: 'stay on the named profile',
        status: 'running',
        turnCount: 0,
        maxTurns: 10,
      } as never;
    };
    adapter.chatStream = async function* (sessionId): AsyncIterable<StreamEvent> {
      goalStreamSawTask = queries.getTask(goalSetupTask.id) !== undefined;
      yield { type: 'done', sessionId, interrupted: true, context: null };
    };

    const goalSetupResponsePromise = fetch(`${base}/api/tasks/${goalSetupTask.id}/messages?profile=writer`, jsonRequest('POST', {
      content: 'start a named-profile goal',
      mode: 'goal',
    }));
    await goalSetupStarted;

    let goalSetupDeletionSettled = false;
    const goalSetupDeletePromise = fetch(
      `${base}/api/tasks/${goalSetupTask.id}?profile=writer`,
      jsonRequest('DELETE'),
    ).then((response) => {
      goalSetupDeletionSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const taskSurvivedGoalSetup = queries.getTask(goalSetupTask.id) !== undefined;
    const deletionWaitedForGoalSetup = !goalSetupDeletionSettled;
    releaseGoalSetup();

    const [goalSetupResponse, goalSetupDeleteResponse] = await Promise.all([
      goalSetupResponsePromise,
      goalSetupDeletePromise,
    ]);
    assert.equal(goalSetupResponse.status, 202);
    assert.equal(goalSetupDeleteResponse.status, 200);
    assert.equal(deletionWaitedForGoalSetup, true, 'deletion must wait for goal setup registered before setGoal resolves');
    assert.equal(taskSurvivedGoalSetup, true, 'named-profile task row must remain available throughout goal setup');
    assert.equal(goalStreamSawTask, true, 'goal streaming must not route after deletion and fall back to the default profile');
    assert.equal(queries.getTask(goalSetupTask.id), undefined);

    const concurrentGoalTask = queries.insertTask({
      title: 'Delete during concurrent named-profile goal setup',
      status: 'in_progress',
      profile_name: 'writer',
    });
    const releaseConcurrentGoalSetups: Array<() => void> = [];
    let markFirstConcurrentGoalSetupStarted!: () => void;
    const firstConcurrentGoalSetupStarted = new Promise<void>((resolve) => {
      markFirstConcurrentGoalSetupStarted = resolve;
    });
    let markSecondConcurrentGoalSetupStarted!: () => void;
    const secondConcurrentGoalSetupStarted = new Promise<void>((resolve) => {
      markSecondConcurrentGoalSetupStarted = resolve;
    });
    let concurrentGoalSetupCount = 0;
    const concurrentGoalStreamsSawTask: boolean[] = [];
    let markLatestConcurrentGoalStreamSettled!: () => void;
    const latestConcurrentGoalStreamSettled = new Promise<void>((resolve) => {
      markLatestConcurrentGoalStreamSettled = resolve;
    });

    adapter.setGoal = async () => {
      const setupIndex = concurrentGoalSetupCount++;
      const blocked = new Promise<void>((resolve) => {
        releaseConcurrentGoalSetups[setupIndex] = resolve;
      });
      if (setupIndex === 0) markFirstConcurrentGoalSetupStarted();
      else markSecondConcurrentGoalSetupStarted();
      await blocked;
      return {
        goal: `concurrent goal ${setupIndex + 1}`,
        status: 'running',
        turnCount: 0,
        maxTurns: 10,
      } as never;
    };
    adapter.chatStream = async function* (sessionId): AsyncIterable<StreamEvent> {
      concurrentGoalStreamsSawTask.push(queries.getTask(concurrentGoalTask.id) !== undefined);
      try {
        yield { type: 'done', sessionId, interrupted: true, context: null };
      } finally {
        if (concurrentGoalStreamsSawTask.length === 1) markLatestConcurrentGoalStreamSettled();
      }
    };

    const firstConcurrentGoalResponsePromise = fetch(
      `${base}/api/tasks/${concurrentGoalTask.id}/messages?profile=writer`,
      jsonRequest('POST', { content: 'start concurrent goal one', mode: 'goal' }),
    );
    await firstConcurrentGoalSetupStarted;
    const secondConcurrentGoalResponsePromise = fetch(
      `${base}/api/tasks/${concurrentGoalTask.id}/messages?profile=writer`,
      jsonRequest('POST', { content: 'start concurrent goal two', mode: 'goal' }),
    );
    await secondConcurrentGoalSetupStarted;

    let concurrentGoalDeletionSettled = false;
    const concurrentGoalDeletePromise = fetch(
      `${base}/api/tasks/${concurrentGoalTask.id}?profile=writer`,
      jsonRequest('DELETE'),
    ).then((response) => {
      concurrentGoalDeletionSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(concurrentGoalDeletionSettled, false, 'deletion must wait while both goal setups are blocked');

    releaseConcurrentGoalSetups[1]();
    const secondConcurrentGoalResponse = await secondConcurrentGoalResponsePromise;
    assert.equal(secondConcurrentGoalResponse.status, 202);
    await latestConcurrentGoalStreamSettled;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletionWaitedForOlderGoalSetup = !concurrentGoalDeletionSettled;
    const taskSurvivedLatestGoalSetup = queries.getTask(concurrentGoalTask.id) !== undefined;

    releaseConcurrentGoalSetups[0]();
    const [firstConcurrentGoalResponse, concurrentGoalDeleteResponse] = await Promise.all([
      firstConcurrentGoalResponsePromise,
      concurrentGoalDeletePromise,
    ]);
    assert.equal(firstConcurrentGoalResponse.status, 202);
    assert.equal(concurrentGoalDeleteResponse.status, 200);
    assert.equal(
      deletionWaitedForOlderGoalSetup,
      true,
      'deletion must not complete after only the latest concurrent goal setup settles',
    );
    assert.equal(taskSurvivedLatestGoalSetup, true, 'task row must survive until every concurrent goal setup settles');
    assert.deepEqual(
      concurrentGoalStreamsSawTask,
      [true, true],
      'neither concurrent goal may resume after deletion and fall back to the default profile',
    );
    assert.equal(queries.getTask(concurrentGoalTask.id), undefined);

    const compactionTask = queries.insertTask({
      title: 'Delete during active compaction',
      status: 'in_progress',
      profile_name: 'default',
    });
    let rejectCompaction!: (error: Error) => void;
    const compactionBlocked = new Promise<never>((_resolve, reject) => { rejectCompaction = reject; });
    let markCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => { markCompactionStarted = resolve; });
    let markCompactionInterrupted!: () => void;
    const compactionInterrupted = new Promise<void>((resolve) => { markCompactionInterrupted = resolve; });
    let compactionSettled = false;
    let compactionSettledBeforeDeletion = false;

    adapter.compressSession = async () => {
      markCompactionStarted();
      try {
        return await compactionBlocked;
      } finally {
        compactionSettled = true;
        compactionSettledBeforeDeletion = queries.getTask(compactionTask.id) !== undefined;
      }
    };
    adapter.interruptChat = async (sessionId, reason) => {
      assert.equal(sessionId, compactionTask.id);
      assert.equal(reason, 'Task deleted');
      markCompactionInterrupted();
      rejectCompaction(new Error('Compaction interrupted because task was deleted'));
      return true;
    };

    const compactionResponsePromise = fetch(
      `${base}/api/tasks/${compactionTask.id}/compact`,
      jsonRequest('POST'),
    );
    await compactionStarted;
    const compactionDeletePromise = fetch(
      `${base}/api/tasks/${compactionTask.id}`,
      jsonRequest('DELETE'),
    );
    const compactionWasInterrupted = await Promise.race([
      compactionInterrupted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (!compactionWasInterrupted) rejectCompaction(new Error('Test released orphan compaction'));

    const [compactionResponse, compactionDeleteResponse] = await Promise.all([
      compactionResponsePromise,
      compactionDeletePromise,
    ]);
    assert.equal(compactionWasInterrupted, true, 'task deletion must interrupt active compaction');
    assert.equal(compactionResponse.status, 503, 'interrupted compaction request must reject');
    assert.equal(compactionDeleteResponse.status, 200);
    assert.equal(compactionSettled, true, 'compaction must settle before deletion returns');
    assert.equal(compactionSettledBeforeDeletion, true, 'task row must survive until compaction settles');
    assert.equal(queries.getTask(compactionTask.id), undefined);
    assert.equal(liveChat.getRun(compactionTask.id), undefined, 'compaction live state must be discarded');

    const collaborationTask = queries.insertTask({
      title: 'Active collaboration deletion',
      status: 'in_progress',
      profile_name: 'default',
    });
    const collaborationSubscriber = fakeResponse();
    liveChat.subscribe(collaborationTask.id, collaborationSubscriber as never);

    let releaseContribution!: () => void;
    const contributionBlocked = new Promise<void>((resolve) => { releaseContribution = resolve; });
    let markContributionStarted!: () => void;
    const contributionStarted = new Promise<void>((resolve) => { markContributionStarted = resolve; });
    let contributionSettled = false;
    let collaborationCancelledBeforeInterrupt = false;

    adapter.getMessages = async () => [];
    adapter.chatForProfile = async () => {
      markContributionStarted();
      try {
        await contributionBlocked;
        return { text: 'late contribution', sessionId: 'collaboration-session' };
      } finally {
        contributionSettled = true;
        assert.ok(queries.getTask(collaborationTask.id), 'collaboration task row must survive until contributor work settles');
      }
    };
    adapter.interruptChatForProfile = async (profileId, sessionId, reason) => {
      assert.equal(profileId, 'writer');
      assert.match(sessionId, /^collaboration-/);
      assert.equal(reason, 'Task deleted');
      const active = taskRunLifecycle.activeCollaborations.get(collaborationTask.id);
      collaborationCancelledBeforeInterrupt = active !== undefined
        && collaborationDb.getCollaborationRun(active.runId)?.status === 'cancelled';
      releaseContribution();
      return true;
    };

    const collaborationResponse = await fetch(`${base}/api/tasks/${collaborationTask.id}/messages`, jsonRequest('POST', {
      content: 'ask writer',
      invitedProfileIds: ['writer'],
    }));
    assert.equal(collaborationResponse.status, 202);
    const collaborationBody = await collaborationResponse.json() as { collaborationRunId: string };
    assert.ok(collaborationBody.collaborationRunId);
    await contributionStarted;

    const collaborationDeleteResponse = await fetch(
      `${base}/api/tasks/${collaborationTask.id}`,
      jsonRequest('DELETE'),
    );
    assert.equal(collaborationDeleteResponse.status, 200);
    assert.equal(collaborationCancelledBeforeInterrupt, true, 'collaboration must be marked cancelled before contributor interruption');
    assert.equal(contributionSettled, true, 'contributor work must not survive task deletion');
    assert.equal(taskRunLifecycle.activeCollaborations.has(collaborationTask.id), false);
    assert.equal(queries.getTask(collaborationTask.id), undefined);
    assert.equal(liveChat.getRun(collaborationTask.id), undefined, 'collaboration live state must be discarded');
    assert.equal(collaborationSubscriber.ended, true, 'collaboration SSE subscribers must be closed');
  } finally {
    adapter.chatStream = originalChatStream;
    adapter.interruptChat = originalInterruptChat;
    adapter.setGoal = originalSetGoal;
    adapter.evaluateGoal = originalEvaluateGoal;
    adapter.compressSession = originalCompressSession;
    adapter.getMessages = originalGetMessages;
    adapter.chatForProfile = originalChatForProfile;
    adapter.interruptChatForProfile = originalInterruptChatForProfile;
    liveChat.closeSubscribersForRestart();
    server.close();
    await once(server, 'close');
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

console.log('Task deletion lifecycle tests passed');
