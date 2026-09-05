import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent } from '../server/adapters/types.js';
import type { BoardEvent, TaskRunState } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-profile-task-isolation-'));
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

async function firstSseEvent(response: Response): Promise<BoardEvent> {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      assert.equal(result.done, false, 'SSE ended before its first event');
      buffer += decoder.decode(result.value, { stream: true });
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) continue;
      const data = buffer.slice(0, boundary)
        .split('\n')
        .find((line) => line.startsWith('data: '));
      assert.ok(data, 'SSE frame did not contain data');
      return JSON.parse(data.slice(6)) as BoardEvent;
    }
  } finally {
    await reader.cancel();
  }
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
    events,
    { localProfileRegistry },
    delegationDb,
    { default: db },
  ] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/queries.js'),
    import('../server/live-chat.js'),
    import('../server/events.js'),
    import('../server/local-profiles.js'),
    import('../server/db/delegations.js'),
    import('../server/db/index.js'),
  ]);

  adapter.getDefaults = async () => ({
    provider: null,
    model: null,
    baseUrl: null,
    apiMode: null,
    reasoningEffort: 'medium',
    showReasoning: true,
  });

  const explicitDefaultTask = queries.insertTask({
    title: 'Explicit default task',
    status: 'in_progress',
    profile_name: 'default',
  });
  const legacyDefaultTask = queries.insertTask({
    title: 'Legacy default task',
    status: 'in_progress',
    profile_name: null,
  });
  const writerTask = queries.insertTask({
    title: 'Writer task',
    status: 'in_progress',
    profile_name: 'writer',
  });
  const writerDelegation = delegationDb.recordDelegationEvent({
    profileId: 'writer',
    taskId: writerTask.id,
    receivedAt: 100,
    event: {
      schema: 'olympus.delegation.event.v1',
      delegationId: 'deleg-writer',
      childId: 'child-writer',
      parentSessionId: writerTask.id,
      childSessionId: 'session-child-writer',
      parentChildId: null,
      childIndex: 0,
      childCount: 1,
      status: 'running',
      currentAction: 'web_search',
      model: 'gpt-5.6-sol',
      toolCount: 1,
      apiCalls: 1,
      durationSeconds: null,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      filesTouched: 0,
    },
  });
  assert.ok(writerDelegation);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const crossProfileRoutes: Array<{ path: string; init?: RequestInit }> = [
      { path: `/api/tasks/${writerTask.id}?profile=default` },
      { path: `/api/tasks/${writerTask.id}?profile=default`, init: jsonRequest('PATCH', { title: 'stolen' }) },
      { path: `/api/tasks/${writerTask.id}/viewed?profile=default`, init: jsonRequest('POST') },
      { path: `/api/tasks/${writerTask.id}/move?profile=default`, init: jsonRequest('POST', { status: 'done' }) },
      { path: `/api/tasks/${writerTask.id}/messages?profile=default` },
      { path: `/api/tasks/${writerTask.id}/messages?profile=default`, init: jsonRequest('POST', { content: 'stolen' }) },
      { path: `/api/tasks/${writerTask.id}/interrupt?profile=default`, init: jsonRequest('POST') },
      { path: `/api/tasks/${writerTask.id}/steer?profile=default`, init: jsonRequest('POST', { content: 'stolen' }) },
      { path: `/api/tasks/${writerTask.id}/compact?profile=default`, init: jsonRequest('POST') },
      { path: `/api/tasks/${writerTask.id}/live?profile=default` },
      { path: `/api/tasks/${writerTask.id}/collaborations?profile=default` },
      { path: `/api/tasks/${writerTask.id}/delegations?profile=default` },
      { path: `/api/tasks/${writerTask.id}/session?profile=default` },
      { path: `/api/tasks/${writerTask.id}/agent-settings?profile=default` },
      { path: `/api/tasks/${writerTask.id}/artifacts/download?profile=default&path=${encodeURIComponent(join(root, 'anything.txt'))}` },
      { path: `/api/tasks/${writerTask.id}?profile=default`, init: jsonRequest('DELETE') },
    ];

    for (const route of crossProfileRoutes) {
      const response = await fetch(`${base}${route.path}`, route.init);
      if (response.body) await response.body.cancel();
      assert.equal(response.status, 404, `${route.init?.method ?? 'GET'} ${route.path} must hide cross-profile tasks`);
    }
    assert.ok(queries.getTask(writerTask.id), 'cross-profile task routes must not mutate or delete the task');

    assert.equal((await fetch(`${base}/api/tasks/${legacyDefaultTask.id}`)).status, 200, 'legacy null-profile tasks belong to default');
    assert.equal((await fetch(`${base}/api/tasks/${legacyDefaultTask.id}/messages`)).status, 200);
    assert.equal((await fetch(`${base}/api/tasks/${legacyDefaultTask.id}/collaborations`)).status, 200);
    assert.equal((await fetch(`${base}/api/tasks/${legacyDefaultTask.id}/session`)).status, 200);
    const writerDelegationsResponse = await fetch(`${base}/api/tasks/${writerTask.id}/delegations?profile=writer`);
    assert.equal(writerDelegationsResponse.status, 200);
    assert.deepEqual((await writerDelegationsResponse.json() as { runs: Array<{ id: string }> }).runs.map((run) => run.id), [writerDelegation.id]);
    assert.equal((await fetch(`${base}/api/tasks/${explicitDefaultTask.id}?profile=writer`)).status, 404);

    liveChat.startRun(explicitDefaultTask.id, explicitDefaultTask.id, 'default run');
    liveChat.startRun(legacyDefaultTask.id, legacyDefaultTask.id, 'legacy run');
    liveChat.startRun(writerTask.id, writerTask.id, 'writer run');

    const legacyLive = await fetch(`${base}/api/tasks/${legacyDefaultTask.id}/live`);
    assert.equal(legacyLive.status, 200, 'legacy default tasks retain live SSE access from default');
    await legacyLive.body?.cancel();

    const defaultSnapshot = await firstSseEvent(await fetch(`${base}/api/events?profile=default`));
    assert.equal(defaultSnapshot.type, 'task_runs_snapshot');
    assert.deepEqual(
      (defaultSnapshot.runs as TaskRunState[]).map((run) => run.taskId).sort(),
      [explicitDefaultTask.id, legacyDefaultTask.id].sort(),
      'default board snapshots include explicit and legacy default runs only',
    );

    const writerSnapshot = await firstSseEvent(await fetch(`${base}/api/events?profile=writer`));
    assert.equal(writerSnapshot.type, 'task_runs_snapshot');
    assert.deepEqual((writerSnapshot.runs as TaskRunState[]).map((run) => run.taskId), [writerTask.id]);

    const invalidProfileResponse = await fetch(`${base}/api/events?profile=missing`);
    if (invalidProfileResponse.body) await invalidProfileResponse.body.cancel();
    assert.equal(invalidProfileResponse.status, 400, 'board SSE must validate the requested profile before opening');

    function fakeResponse() {
      const writes: string[] = [];
      let ended = false;
      let resolveEnded!: () => void;
      const endedPromise = new Promise<void>((resolve) => { resolveEnded = resolve; });
      return {
        writes,
        endedPromise,
        get ended() { return ended; },
        write(value: string) { writes.push(value); return true; },
        end() {
          ended = true;
          resolveEnded();
        },
        on() { return this; },
      };
    }

    const defaultClient = fakeResponse();
    const writerClient = fakeResponse();
    events.addClient(defaultClient as never, localProfileRegistry.default());
    events.addClient(writerClient as never, localProfileRegistry.requireActive('writer'));
    events.broadcast({ type: 'task_updated', task: writerTask });
    events.broadcast({ type: 'task_run_updated', run: liveChat.getRunStatus(writerTask.id)! });
    events.broadcast({ type: 'task_deleted', taskId: writerTask.id }, writerTask);
    events.broadcast({ type: 'delegation_run_updated', run: writerDelegation }, writerTask);

    assert.equal(defaultClient.writes.join('').includes(writerTask.id), false, 'default board stream must not receive writer events');
    assert.equal(writerClient.writes.filter((write) => write.includes(writerTask.id)).length, 4, 'writer board stream receives its task and delegation events');

    const secondWriterTask = queries.insertTask({
      title: 'Second writer task',
      status: 'in_progress',
      profile_name: 'writer',
    });
    const secondWriterLiveClient = fakeResponse();
    liveChat.subscribe(secondWriterTask.id, secondWriterLiveClient as never);

    let releaseAgentRun!: () => void;
    const agentRunBlocked = new Promise<void>((resolve) => { releaseAgentRun = resolve; });
    let markAgentRunStarted!: () => void;
    const agentRunStarted = new Promise<void>((resolve) => { markAgentRunStarted = resolve; });
    const originalChatStream = adapter.chatStream;
    adapter.getBackgroundWork = async () => ({ available: true, work: [] });
    adapter.chatStream = async function* (): AsyncIterable<StreamEvent> {
      markAgentRunStarted();
      await agentRunBlocked;
      yield { type: 'text_delta', content: 'finished before profile backup' };
      yield { type: 'done', sessionId: secondWriterTask.id, context: null };
    };

    const runResponse = await fetch(`${base}/api/tasks/${secondWriterTask.id}/messages?profile=writer`, jsonRequest('POST', {
      content: 'hold profile deletion until this detached run finishes',
    }));
    assert.equal(runResponse.status, 202);
    await runResponse.json();
    await agentRunStarted;

    const oldWriterBoardWriteCount = writerClient.writes.length;

    let releaseProfileDelete!: () => void;
    const profileDeleteBlocked = new Promise<void>((resolve) => { releaseProfileDelete = resolve; });
    let profileDeleteStarted!: () => void;
    const profileDeleteEntered = new Promise<void>((resolve) => { profileDeleteStarted = resolve; });
    let profileDeleteDidEnter = false;
    let runAtBackup = liveChat.getRun(secondWriterTask.id);
    let backedUpTasks: Array<{ id: string }> = [];
    const originalProfileDelete = localProfileRegistry.delete;
    localProfileRegistry.delete = async (_id, _confirmation, _currentProfileId, accompanyingData) => {
      profileDeleteDidEnter = true;
      runAtBackup = liveChat.getRun(secondWriterTask.id);
      backedUpTasks = (accompanyingData as { tasks: Array<{ id: string }> }).tasks;
      profileDeleteStarted();
      await profileDeleteBlocked;
      return { backupDir: join(root, 'mock-profile-backup') };
    };

    try {
      const deletionResponsePromise = fetch(`${base}/api/profiles/writer?profile=default`, jsonRequest('DELETE', {
        confirmation: 'writer',
      }));
      await secondWriterLiveClient.endedPromise;

      assert.equal(writerClient.ended, true, 'profile deletion revokes its existing board clients before filesystem work');
      assert.equal(secondWriterLiveClient.ended, true, 'profile deletion revokes existing per-task live subscribers before filesystem work');
      assert.equal(
        profileDeleteDidEnter,
        false,
        'profile backup/delete must wait after HTTP 202 until the detached task agent run finishes',
      );

      releaseAgentRun();
      await profileDeleteEntered;
      assert.equal(
        runAtBackup?.messages.some((message) => message.content.includes('finished before profile backup')),
        true,
        'the detached stream must finish writing its live run before profile backup',
      );
      assert.equal(runAtBackup?.status, 'done', 'the detached run must reach terminal cleanup before profile backup');

      const expectProfileDeleting = async (path: string, init: RequestInit) => {
        const response = await fetch(`${base}${path}`, init);
        assert.equal(response.status, 409, `${init.method} ${path} must reject work while profile deletion is active`);
        assert.equal((await response.json() as { code: string }).code, 'PROFILE_DELETING');
      };

      await expectProfileDeleting('/api/tasks?profile=writer', jsonRequest('POST', {
        description: 'must not be admitted',
      }));
      await expectProfileDeleting(`/api/tasks/${writerTask.id}?profile=writer`, jsonRequest('PATCH', {
        title: 'must not change',
      }));
      await expectProfileDeleting('/api/agent/defaults?profile=writer', jsonRequest('PATCH', {
        model: 'must-not-change',
      }));
      await expectProfileDeleting('/api/skills/install?profile=writer', jsonRequest('POST', {
        provider: 'clawhub',
        slug: 'must-not-install',
      }));
      await expectProfileDeleting('/api/skills/import?profile=writer', jsonRequest('POST', {}));
      await expectProfileDeleting('/api/skills/must-not-delete?profile=writer', jsonRequest('DELETE'));
      await expectProfileDeleting('/api/profiles/draft?profile=writer', jsonRequest('POST', {
        description: 'must not draft',
      }));
      await expectProfileDeleting('/api/profiles', jsonRequest('POST', {
        id: 'writer',
        displayName: 'Replacement Writer',
      }));
      await expectProfileDeleting('/api/profiles/writer/settings?profile=default', jsonRequest('PATCH', {
        displayName: 'must not change',
      }));

      const readOnlyProfiles = await fetch(`${base}/api/profiles?includeInactive=true`);
      assert.equal(readOnlyProfiles.status, 200, 'read-only profile listing must not be lifecycle-gated');
      assert.ok((await readOnlyProfiles.json() as { profiles: Array<{ id: string }> }).profiles.some((profile) => profile.id === 'writer'));
      assert.throws(
        () => queries.insertTask({ title: 'background insert', status: 'in_progress', profile_name: 'writer' }),
        (error: unknown) => (error as { code?: string }).code === 'PROFILE_DELETING',
        'background task creation is rejected while the profile deletion lock is held',
      );
      assert.equal(
        queries.updateTask(writerTask.id, { title: 'background update' }),
        undefined,
        'background task updates are not applied while the profile deletion lock is held',
      );

      releaseProfileDelete();
      const deletionResponse = await deletionResponsePromise;
      assert.equal(deletionResponse.status, 200);
      const deletionBody = await deletionResponse.json() as { deletedTaskCount: number };
      assert.equal(deletionBody.deletedTaskCount, 2);
      assert.deepEqual(
        backedUpTasks.map((task) => task.id).sort(),
        [writerTask.id, secondWriterTask.id].sort(),
        'the deletion backup contains the stable, complete task set',
      );
      assert.equal(queries.getTask(writerTask.id), undefined);
      assert.equal(queries.getTask(secondWriterTask.id), undefined);
      assert.equal(liveChat.getRun(secondWriterTask.id), undefined, 'profile deletion discards completed live state before task rows are removed');

      const replacementWriterBoard = fakeResponse();
      const replacementWriterLive = fakeResponse();
      events.addClient(replacementWriterBoard as never, localProfileRegistry.requireActive('writer'));
      liveChat.subscribe(secondWriterTask.id, replacementWriterLive as never);
      events.broadcast({ type: 'task_updated', task: writerTask });
      liveChat.broadcast(secondWriterTask.id, { type: 'text_delta', content: 'new incarnation' });

      assert.equal(writerClient.writes.length, oldWriterBoardWriteCount, 'revoked board client stays detached after the same profile ID returns');
      assert.equal(secondWriterLiveClient.writes.join('').includes('new incarnation'), false, 'revoked live client stays detached after the same profile ID returns');
      assert.equal(replacementWriterBoard.writes.join('').includes(writerTask.id), true);
      assert.equal(replacementWriterLive.writes.join('').includes('new incarnation'), true);
    } finally {
      adapter.chatStream = originalChatStream;
      localProfileRegistry.delete = originalProfileDelete;
      releaseAgentRun();
      releaseProfileDelete();
    }
    events.closeClientsForRestart();
    liveChat.closeSubscribersForRestart();
  } finally {
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

console.log('Profile task and SSE isolation tests passed');
