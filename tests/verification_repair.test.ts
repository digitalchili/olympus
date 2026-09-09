import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'verification-repair-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
const { getRecovery, reconcileRecoveries, cancelRecovery, recoverRecoveryRecords, beginRecovery, verificationRepairPrompt } = await import('../server/run-recovery.js');
const { hasActiveTaskRun } = await import('../server/task-run-lifecycle.js');
const { putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
const post = (id: string, body: unknown, path = 'messages') => fetch(`${api}/${id}/${path}?profile=default`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Task did not settle');
};
const work = new Map<string, { cwd: string; starts: number; repair: boolean; repairAt?: number; progress?: boolean; nativeLimit?: boolean }>();
adapter.getBackgroundWork = async (id) => ({ available: true, work: [], continuation: { status: work.get(id)?.nativeLimit && work.get(id)?.starts === 2 ? 'pending' : 'none' } });
adapter.chatStream = async function* (id, content, options) {
  const task = work.get(id)!;
  task.starts++;
  if (task.nativeLimit && task.starts === 3) {
    assert.equal(options?.recoveryContinuation, true, 'native interruption still resumes through its checkpoint');
  } else if (task.starts > 1) {
    assert.match(content, /fixture check failed/);
    assert.match(content, /untrusted/i);
    assert.match(content, /timezone/i);
    assert.equal(options?.recoveryContinuation, false, 'verification repair is a new normal Hermes turn, not a native interrupted checkpoint');
  }
  if (task.nativeLimit && task.starts === 2) {
    yield { type: 'error', error: 'Iteration limit', code: 'iteration_limit' };
    return;
  }
  await writeFile(join(task.cwd, 'source'), task.starts >= (task.repairAt ?? 2) && task.repair ? 'fixed' : task.progress ? `bad-${task.starts}` : 'bad');
  yield { type: 'text_delta', content: 'Work finished.' };
  yield { type: 'done', sessionId: id };
};
async function fixture(name: string, repair = true) {
  const cwd = join(root, name);
  await mkdir(join(cwd, '.olympus'), { recursive: true });
  await writeFile(join(cwd, 'source'), 'original');
  await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e',
    "if(require('fs').readFileSync('source','utf8')!=='fixed'){console.error('fixture check failed');process.exit(1)}",
  ]] }));
  for (const args of [['init'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'Initial']]) {
    await promisify(execFile)('git', args, { cwd });
  }
  const task = insertTask({ title: name, status: 'in_progress', workdir: cwd, profile_name: 'default' });
  work.set(task.id, { cwd, starts: 0, repair });
  assert.equal((await post(task.id, { content: 'Fix this code' })).status, 202);
  await wait(() => getLatestTaskAgentRun(task.id)?.status === 'done' && !hasActiveTaskRun(task.id));
  assert.equal(getTask(task.id)?.status, 'in_progress');
  assert.equal(getRecovery(task.id)?.state, 'pending', 'failed checks must persist a repair request automatically');
  return task;
}
const deliver = async (id: string, runId: string) => {
  const response = await post(id, { recoveryOfRunId: runId, content: 'server recovery', settings: { mode: 'task' } });
  assert.equal(response.status, 202, await response.text());
};
try {
  await test('failed checks feed the agent diagnostics and automatically reach review only after a passing repair', async () => {
    const task = await fixture('repair');
    await reconcileRecoveries(adapter, deliver);
    await wait(() => getTask(task.id)?.status === 'in_review');
    assert.equal(work.get(task.id)?.starts, 2);
    assert.equal(getRecovery(task.id)?.state, 'complete');
  });
  await test('unchanged failed repair stops with an actionable blocker instead of repeating forever', async () => {
    const task = await fixture('no-progress', false);
    await reconcileRecoveries(adapter, deliver);
    await wait(() => getRecovery(task.id)?.state === 'blocked');
    await reconcileRecoveries(adapter, deliver);
    assert.equal(work.get(task.id)?.starts, 2);
    assert.equal(getTask(task.id)?.status, 'in_progress');
    assert.match(getRecovery(task.id)?.reason ?? '', /no source change/i);
  });
  await test('repairs that change source can continue beyond two attempts', async () => {
    const task = await fixture('several-repairs');
    Object.assign(work.get(task.id)!, { repairAt: 4, progress: true });
    for (let turn = 2; turn <= 4; turn++) {
      await reconcileRecoveries(adapter, deliver);
      await wait(() => work.get(task.id)!.starts === turn && !hasActiveTaskRun(task.id));
    }
    assert.equal(getTask(task.id)?.status, 'in_review');
    assert.equal(work.get(task.id)?.starts, 4);
  });
  await test('native recovery within a repair chain reruns unchanged failing checks', async () => {
    const task = await fixture('native-repair', false);
    work.get(task.id)!.nativeLimit = true;
    await reconcileRecoveries(adapter, deliver);
    await wait(() => getLatestTaskAgentRun(task.id)?.status === 'error' && !hasActiveTaskRun(task.id));
    await reconcileRecoveries(adapter, deliver);
    await wait(() => work.get(task.id)!.starts === 3 && !hasActiveTaskRun(task.id));
    const { readCodingEvidence } = await import('../server/coding-verification.js');
    assert.equal((await readCodingEvidence(getTask(task.id)!))?.status, 'failed', 'native continuation must rerun the failed command, not skip unchanged source');
    assert.equal(getRecovery(task.id)?.state, 'blocked');
    assert.equal(getTask(task.id)?.status, 'in_progress');
  });
  await test('duplicate manual check admission preserves the queued repair', async () => {
    const task = await fixture('manual-duplicate');
    const before = getRecovery(task.id);
    const original = adapter.getBackgroundWork;
    adapter.getBackgroundWork = async () => ({ available: false, work: [] });
    try {
      assert.equal((await post(task.id, {}, 'verification')).status, 409);
      assert.deepEqual(getRecovery(task.id), before, 'rejected checks cannot discard durable repair');
    } finally { adapter.getBackgroundWork = original; }
    cancelRecovery(task.id);
  });
  await test('Stop and queued human messages take priority over automatic repair', async () => {
    const stopped = await fixture('stopped');
    cancelRecovery(stopped.id);
    const queued = await fixture('queued');
    putQueuedTaskMessage({ id: 'human-message', taskId: queued.id, content: 'New direction', settings: { mode: 'task' }, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: Date.now(), updatedAt: Date.now() });
    await reconcileRecoveries(adapter, deliver);
    assert.equal(work.get(stopped.id)?.starts, 1);
    assert.equal(work.get(queued.id)?.starts, 1);
  });
  await test('restart restores an undispatched repair without requiring a Hermes interrupted checkpoint', async () => {
    const task = await fixture('restart');
    db.prepare("UPDATE task_recovery SET state='dispatching' WHERE task_id=?").run(task.id);
    recoverRecoveryRecords();
    assert.equal(getRecovery(task.id)?.state, 'pending');
    await reconcileRecoveries(adapter, deliver);
    await wait(() => getTask(task.id)?.status === 'in_review');
    assert.equal(work.get(task.id)?.starts, 2);
  });
  await test('Stop during manual check admission is not cleared when the background probe finishes', async () => {
    const task = await fixture('manual-stop');
    cancelRecovery(task.id);
    const original = adapter.getBackgroundWork;
    let ready = false;
    let release!: () => void;
    adapter.getBackgroundWork = async () => { ready = true; await new Promise<void>(resolve => { release = resolve; }); return { available: true, work: [] }; };
    const checking = post(task.id, {}, 'verification');
    await wait(() => ready);
    await post(task.id, {}, 'interrupt');
    release();
    const response = await checking;
    adapter.getBackgroundWork = original;
    assert.equal(response.status, 409, 'Stopped check preparation must not execute verification');
    assert.equal(getRecovery(task.id)?.state, 'blocked');
    await reconcileRecoveries(adapter, deliver);
    assert.equal(work.get(task.id)?.starts, 1);
  });
  for (const action of ['stop', 'new-run']) await test(`source snapshot completion cannot override ${action}`, async () => {
    const task = await fixture(`snapshot-${action}`);
    const runId = getLatestTaskAgentRun(task.id)!.runId;
    const bin = join(root, `git-${action}`); await mkdir(bin);
    const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
    const ready = join(root, `ready-${action}`), release = join(root, `release-${action}`);
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'); const args=process.argv.slice(2); const run=()=>{const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1)}; if(args[0]==='rev-parse'&&args[1]==='HEAD'){fs.writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);run()}},10)}else run();\n`);
    await chmod(join(bin, 'git'), 0o755);
    const originalPath = process.env.PATH;
    let pending: Promise<string | null> | undefined;
    try {
      process.env.PATH = `${bin}:${originalPath}`;
      pending = verificationRepairPrompt(task.id, runId);
      await wait(() => existsSync(ready));
      if (action === 'stop') cancelRecovery(task.id);
      else {
        beginRecovery(task.id, 'newer-run', Date.now());
        await writeFile(join(work.get(task.id)!.cwd, 'source'), 'newer work');
      }
      await writeFile(release, 'continue');
      assert.equal(await pending, null, 'Stale repair cannot authorize another turn');
      assert.equal(getRecovery(task.id)?.state, action === 'stop' ? 'blocked' : 'running');
    } finally {
      await writeFile(release, 'continue');
      await pending?.catch(() => {});
      process.env.PATH = originalPath;
    }
  });
} finally {
  await wait(() => [...work.keys()].every(id => !hasActiveTaskRun(id)));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); await rm(root, { recursive: true, force: true });
}
