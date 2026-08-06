import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AgentAdapter } from '../server/adapters/types.js';
import type { ScheduledTask, ScheduledTaskInput } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-scheduled-task-profile-isolation-'));
const hermesHome = join(root, 'hermes');
const previousHermesHome = process.env.HERMES_HOME;

function task(id: string, name: string, enabled = true): ScheduledTask {
  return {
    id,
    name,
    prompt: `${name} prompt`,
    schedule: { kind: 'cron', expression: '0 * * * *' },
    scheduleDisplay: '0 * * * *',
    enabled,
    state: enabled ? 'active' : 'paused',
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDeliveryError: null,
    model: null,
    provider: null,
    baseUrl: null,
    deliver: null,
    origin: null,
    repeat: null,
    contextFrom: [],
    skills: [],
    workdir: null,
    createdAt: null,
  };
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

try {
  await mkdir(join(hermesHome, 'profiles', 'writer', 'cron', 'output', 'writer-task'), { recursive: true });
  await mkdir(join(hermesHome, 'profiles', 'inactive'), { recursive: true });
  await mkdir(join(hermesHome, 'cron', 'output', 'default-task'), { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
  await writeFile(join(hermesHome, 'cron', 'output', 'default-task', '2026-08-06_09-00-00.md'), '# Cron Job: Default task\n\n## Response\ndefault secret output\n');
  await writeFile(join(hermesHome, 'profiles', 'writer', 'profile.yaml'), 'displayName: Writer\n');
  await writeFile(join(hermesHome, 'profiles', 'writer', 'config.yaml'), '{}\n');
  await writeFile(join(hermesHome, 'profiles', 'writer', 'cron', 'output', 'writer-task', '2026-08-06_10-00-00.md'), '# Cron Job: Writer task\n\n## Response\nwriter output\n');
  await writeFile(join(hermesHome, 'profiles', 'inactive', 'profile.yaml'), 'displayName: Inactive\nactive: false\n');
  await writeFile(join(hermesHome, 'profiles', 'inactive', 'config.yaml'), '{}\n');
  process.env.HERMES_HOME = hermesHome;

  const [{ createScheduledTasksRouter }, { beginProfileDeletion }] = await Promise.all([
    import('../server/routes/scheduled-tasks.js'),
    import('../server/profile-deletion.js'),
  ]);
  const tasksByProfile = new Map<string, Map<string, ScheduledTask>>([
    ['default', new Map([['default-task', task('default-task', 'Default task')]])],
    ['writer', new Map([['writer-task', task('writer-task', 'Writer task')]])],
  ]);
  const profileId = (value?: string | null) => value ?? 'default';
  const profileTasks = (value?: string | null) => tasksByProfile.get(profileId(value)) ?? new Map<string, ScheduledTask>();
  let nextId = 1;

  const scheduledAdapter = {
    async listScheduledTasks(_includeDisabled?: boolean, _limit?: number, requestedProfileId?: string | null) {
      return [...profileTasks(requestedProfileId).values()];
    },
    async getScheduledTask(id: string, requestedProfileId?: string | null) {
      return profileTasks(requestedProfileId).get(id) ?? null;
    },
    async createScheduledTask(input: ScheduledTaskInput, requestedProfileId?: string | null) {
      const created = task(`${profileId(requestedProfileId)}-created-${nextId++}`, input.name ?? 'Created task');
      profileTasks(requestedProfileId).set(created.id, created);
      return created;
    },
    async updateScheduledTask(id: string, updates: Partial<ScheduledTaskInput>, requestedProfileId?: string | null) {
      const current = profileTasks(requestedProfileId).get(id);
      if (!current) return null;
      const updated = { ...current, ...(updates.name === undefined ? {} : { name: updates.name }) };
      profileTasks(requestedProfileId).set(id, updated);
      return updated;
    },
    async pauseScheduledTask(id: string, _reason?: string, requestedProfileId?: string | null) {
      const current = profileTasks(requestedProfileId).get(id);
      if (!current) return null;
      const updated = { ...current, enabled: false, state: 'paused' };
      profileTasks(requestedProfileId).set(id, updated);
      return updated;
    },
    async resumeScheduledTask(id: string, requestedProfileId?: string | null) {
      const current = profileTasks(requestedProfileId).get(id);
      if (!current) return null;
      const updated = { ...current, enabled: true, state: 'active' };
      profileTasks(requestedProfileId).set(id, updated);
      return updated;
    },
    async runScheduledTask(id: string, requestedProfileId?: string | null) {
      const current = profileTasks(requestedProfileId).get(id);
      if (!current) return null;
      const updated = { ...current, lastStatus: 'ok' as const };
      profileTasks(requestedProfileId).set(id, updated);
      return updated;
    },
    async removeScheduledTask(id: string, requestedProfileId?: string | null) {
      return profileTasks(requestedProfileId).delete(id);
    },
  } as unknown as AgentAdapter;

  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-tasks', createScheduledTasksRouter(scheduledAdapter));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const defaultBefore = structuredClone(tasksByProfile.get('default')!.get('default-task'));

    const writerList = await fetch(`${base}/api/scheduled-tasks?profile=writer`);
    assert.equal(writerList.status, 200);
    assert.deepEqual(
      ((await writerList.json()) as { scheduledTasks: ScheduledTask[] }).scheduledTasks.map(({ id }) => id),
      ['writer-task'],
      'named profile lists must not expose default scheduled tasks',
    );

    assert.equal((await fetch(`${base}/api/scheduled-tasks/default-task?profile=writer`)).status, 404);

    const writerRuns = await fetch(`${base}/api/scheduled-tasks/writer-task/runs?profile=writer`);
    assert.equal(writerRuns.status, 200);
    assert.deepEqual(
      ((await writerRuns.json()) as { runs: Array<{ id: string }> }).runs.map(({ id }) => id),
      ['2026-08-06_10-00-00'],
    );
    const hiddenDefaultRuns = await fetch(`${base}/api/scheduled-tasks/default-task/runs?profile=writer`);
    assert.equal(hiddenDefaultRuns.status, 200);
    assert.deepEqual(((await hiddenDefaultRuns.json()) as { runs: unknown[] }).runs, []);
    assert.equal(
      (await fetch(`${base}/api/scheduled-tasks/default-task/runs/2026-08-06_09-00-00/content?profile=writer`)).status,
      404,
      'named profile run reads must not expose default scheduled task output',
    );

    const createdResponse = await fetch(`${base}/api/scheduled-tasks?profile=writer`, jsonRequest('POST', {
      name: 'Writer created task',
      prompt: 'Write a report',
      schedule: '0 9 * * *',
    }));
    assert.equal(createdResponse.status, 200);
    const created = ((await createdResponse.json()) as { scheduledTask: ScheduledTask }).scheduledTask;
    assert.equal(tasksByProfile.get('writer')?.has(created.id), true, 'named creates must use the named profile worker');
    assert.equal(tasksByProfile.get('default')?.has(created.id), false);

    const crossProfileMutations: Array<{ path: string; init: RequestInit }> = [
      { path: '/default-task', init: jsonRequest('PATCH', { name: 'stolen' }) },
      { path: '/default-task/pause', init: jsonRequest('POST', { reason: 'stolen' }) },
      { path: '/default-task/resume', init: jsonRequest('POST') },
      { path: '/default-task/run', init: jsonRequest('POST') },
      { path: '/default-task', init: jsonRequest('DELETE') },
    ];
    for (const mutation of crossProfileMutations) {
      const response = await fetch(`${base}/api/scheduled-tasks${mutation.path}?profile=writer`, mutation.init);
      assert.equal(response.status, 404, `${mutation.init.method} ${mutation.path} must not mutate a default scheduled task`);
    }
    assert.deepEqual(tasksByProfile.get('default')?.get('default-task'), defaultBefore);

    const legacyDefaultList = await fetch(`${base}/api/scheduled-tasks`);
    assert.equal(legacyDefaultList.status, 200);
    assert.deepEqual(
      ((await legacyDefaultList.json()) as { scheduledTasks: ScheduledTask[] }).scheduledTasks.map(({ id }) => id),
      ['default-task'],
      'requests without a profile keep legacy default behavior',
    );
    assert.equal((await fetch(`${base}/api/scheduled-tasks/default-task`)).status, 200);

    const unknown = await fetch(`${base}/api/scheduled-tasks?profile=missing`);
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as { code: string }).code, 'UNKNOWN_PROFILE');

    const inactive = await fetch(`${base}/api/scheduled-tasks?profile=inactive`);
    assert.equal(inactive.status, 409);
    assert.equal(((await inactive.json()) as { code: string }).code, 'INACTIVE_PROFILE');

    const originalListScheduledTasks = scheduledAdapter.listScheduledTasks;
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    scheduledAdapter.listScheduledTasks = async (...args) => {
      markReadStarted();
      await readBlocked;
      return originalListScheduledTasks(...args);
    };
    const readResponsePromise = fetch(`${base}/api/scheduled-tasks?profile=writer`);
    await readStarted;
    const readDeletionLock = beginProfileDeletion('writer');
    try {
      await readDeletionLock.waitForIdle();
      releaseRead();
      assert.equal((await readResponsePromise).status, 200, 'read-only listing remains outside the lifecycle work gate');
    } finally {
      releaseRead();
      readDeletionLock.release();
      scheduledAdapter.listScheduledTasks = originalListScheduledTasks;
    }

    const originalUpdateScheduledTask = scheduledAdapter.updateScheduledTask;
    const oldWriterTasks = tasksByProfile.get('writer')!;
    let releaseMutation!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => { releaseMutation = resolve; });
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve; });
    let mutationCalls = 0;
    scheduledAdapter.updateScheduledTask = async (id, updates, requestedProfileId) => {
      mutationCalls += 1;
      markMutationStarted();
      await mutationBlocked;
      const current = oldWriterTasks.get(id);
      if (!current || requestedProfileId !== 'writer') return null;
      const updated = { ...current, ...(updates.name === undefined ? {} : { name: updates.name }) };
      oldWriterTasks.set(id, updated);
      return updated;
    };

    const mutationResponsePromise = fetch(
      `${base}/api/scheduled-tasks/writer-task?profile=writer`,
      jsonRequest('PATCH', { name: 'Finished before deletion' }),
    );
    await mutationStarted;

    const mutationDeletionLock = beginProfileDeletion('writer');
    let deletionBecameIdle = false;
    const deletionIdle = mutationDeletionLock.waitForIdle().then(() => { deletionBecameIdle = true; });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(deletionBecameIdle, false, 'profile deletion must wait for an in-flight scheduled mutation');

      releaseMutation();
      assert.equal((await mutationResponsePromise).status, 200);
      await deletionIdle;
      assert.equal(oldWriterTasks.get('writer-task')?.name, 'Finished before deletion');

      const rejectedMutation = await fetch(
        `${base}/api/scheduled-tasks/writer-task?profile=writer`,
        jsonRequest('PATCH', { name: 'Must not cross deletion' }),
      );
      assert.equal(rejectedMutation.status, 409);
      assert.equal(((await rejectedMutation.json()) as { code: string }).code, 'PROFILE_DELETING');
      assert.equal(mutationCalls, 1, 'mutations admitted after deletion starts must not reach the adapter');

      const recreatedWriterTasks = new Map([['writer-task', task('writer-task', 'Recreated writer task')]]);
      tasksByProfile.set('writer', recreatedWriterTasks);
      scheduledAdapter.updateScheduledTask = originalUpdateScheduledTask;
      mutationDeletionLock.release();

      const recreatedMutation = await fetch(
        `${base}/api/scheduled-tasks/writer-task?profile=writer`,
        jsonRequest('PATCH', { name: 'New incarnation only' }),
      );
      assert.equal(recreatedMutation.status, 200);
      assert.equal(recreatedWriterTasks.get('writer-task')?.name, 'New incarnation only');
      assert.equal(
        oldWriterTasks.get('writer-task')?.name,
        'Finished before deletion',
        'the old in-flight mutation cannot land in the recreated profile state',
      );
    } finally {
      releaseMutation();
      mutationDeletionLock.release();
      scheduledAdapter.updateScheduledTask = originalUpdateScheduledTask;
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
} finally {
  if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousHermesHome;
  await rm(root, { recursive: true, force: true });
}

console.log('Scheduled task profile isolation tests passed');
