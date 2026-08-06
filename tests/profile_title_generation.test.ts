import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../server/adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-profile-title-generation-'));
const hermesHome = join(root, 'hermes');
const writerHome = join(hermesHome, 'profiles', 'writer');
const dispatchHome = join(root, 'dispatch');
const previousHermesHome = process.env.HERMES_HOME;
const previousDispatchHome = process.env.OLYMPUS_DISPATCH_HOME;
const previousDbPath = process.env.DB_PATH;

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    { ProfileAgentAdapter },
    { localProfileRegistry },
    { beginProfileDeletion },
    { default: db },
  ] = await Promise.all([
    import('../server/app.js'),
    import('../server/adapters/routing.js'),
    import('../server/local-profiles.js'),
    import('../server/profile-deletion.js'),
    import('../server/db/index.js'),
  ]);

  const calls: string[] = [];
  let markNamedTitleStarted!: () => void;
  const namedTitleStarted = new Promise<void>((resolve) => { markNamedTitleStarted = resolve; });
  let releaseNamedTitle!: () => void;
  const namedTitleBlocked = new Promise<void>((resolve) => { releaseNamedTitle = resolve; });

  const defaultAdapter = {
    async generateTitle() {
      calls.push('default');
      return { title: 'Default generated title' };
    },
  } as AgentAdapter;
  const titleAdapter = new ProfileAgentAdapter(defaultAdapter, {
    registry: localProfileRegistry,
    createAdapter(profile) {
      return {
        async generateTitle() {
          calls.push(profile.id);
          markNamedTitleStarted();
          await namedTitleBlocked;
          return { title: 'Writer generated title' };
        },
      } as AgentAdapter;
    },
  });

  assert.equal(
    (await titleAdapter.generateTitle('Legacy title request')).title,
    'Default generated title',
    'omitting a profile must preserve legacy default-worker behavior',
  );

  const originalGenerateTitle = adapter.generateTitle;
  adapter.generateTitle = titleAdapter.generateTitle.bind(titleAdapter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  let deletionLock: ReturnType<typeof beginProfileDeletion> | null = null;
  try {
    const createdResponse = await fetch(`${base}/api/tasks?profile=writer`, jsonRequest('POST', {
      description: 'Draft a launch announcement for the writer profile',
    }));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { task: { id: string; profile_name: string } };
    assert.equal(created.task.profile_name, 'writer');

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['default', 'writer'], 'automatic title generation must use the resolved named-profile adapter');
    await namedTitleStarted;

    deletionLock = beginProfileDeletion('writer');
    let becameIdle = false;
    const idle = deletionLock.waitForIdle().then(() => { becameIdle = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(becameIdle, false, 'profile deletion must wait for in-flight automatic title generation');
    await assert.rejects(
      () => titleAdapter.generateTitle('Must not start during deletion', 'writer'),
      (error: unknown) => (error as { code?: string }).code === 'PROFILE_DELETING',
      'automatic title generation must reject new work after profile deletion begins',
    );

    const rejectedResponse = await fetch(`${base}/api/tasks?profile=writer`, jsonRequest('POST', {
      description: 'This task must not start while writer deletion is active',
    }));
    assert.equal(rejectedResponse.status, 409);
    assert.equal((await rejectedResponse.json() as { code: string }).code, 'PROFILE_DELETING');

    releaseNamedTitle();
    await idle;
    assert.equal(becameIdle, true);
  } finally {
    releaseNamedTitle();
    deletionLock?.release();
    adapter.generateTitle = originalGenerateTitle;
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

console.log('Profile-aware title generation lifecycle tests passed');
