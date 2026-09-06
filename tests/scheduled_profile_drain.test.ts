import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../server/adapters/types.js';

const home = await mkdtemp(join(tmpdir(), 'olympus-scheduled-drain-'));
process.env.OLYMPUS_DISPATCH_HOME = join(home, 'olympus');
process.env.HERMES_HOME = join(home, 'hermes');
process.env.DB_PATH = join(home, 'olympus', 'data', 'state.db');
const { ProfileAgentAdapter } = await import('../server/adapters/routing.js');
const { LocalProfileRegistry } = await import('../server/local-profiles.js');

function worker() {
  return {
    draining: false, jobs: 0, fail: false, started: false,
    startBarrier: Promise.resolve(),
    async start() { await this.startBarrier; this.started = true; },
    async stop() {},
    setScheduledTasksDraining(value: boolean) { this.draining = value; },
    async getScheduledTaskDrainStatus() {
      if (this.fail) throw new Error('worker unavailable');
      return { draining: this.draining, activeRuns: this.jobs };
    },
    async listScheduledTasks() { return []; },
  };
}

try {
  await mkdir(join(process.env.HERMES_HOME, 'profiles', 'writer'), { recursive: true });
  await writeFile(join(process.env.HERMES_HOME, 'profiles', 'writer', 'profile.yaml'), 'displayName: Writer\n');
  const primary = worker(), named = worker();
  let releaseStart!: () => void;
  named.startBarrier = new Promise<void>((resolve) => { releaseStart = resolve; });
  const adapter = new ProfileAgentAdapter(primary as unknown as AgentAdapter, {
    registry: new LocalProfileRegistry(process.env.HERMES_HOME),
    createAdapter: () => named as unknown as AgentAdapter,
  });
  assert.equal(typeof adapter.setScheduledTasksDraining, 'function', 'profile routing must propagate maintenance state');
  adapter.setScheduledTasksDraining(true);
  const startup = adapter.listScheduledTasks(false, 10, 'writer');
  assert.equal(named.draining, true, 'late-starting profile inherits drain before start');
  await assert.rejects(adapter.getScheduledTaskDrainStatus(), /starting/i, 'starting profile is unknown');
  releaseStart();
  await startup;
  primary.jobs = 1;
  named.jobs = 2;
  assert.deepEqual(await adapter.getScheduledTaskDrainStatus(), { draining: true, activeRuns: 3 });
  named.fail = true;
  await assert.rejects(adapter.getScheduledTaskDrainStatus(), /unavailable/, 'failed named worker cannot be omitted');
  named.fail = false;
  adapter.setScheduledTasksDraining(false);
  assert.equal(primary.draining, false);
  assert.equal(named.draining, false);
  await adapter.stop();
  named.start = async () => { throw new Error('startup failed'); };
  await assert.rejects(adapter.listScheduledTasks(false, 10, 'writer'), /startup failed/);
  await assert.rejects(adapter.getScheduledTaskDrainStatus(), /starting|ready/i, 'failed startup cannot disappear from the drain inventory');
} finally {
  const { default: db } = await import('../server/db/index.js');
  db.close();
  await rm(home, { recursive: true, force: true });
}
console.log('Profile scheduled drain tests passed');
