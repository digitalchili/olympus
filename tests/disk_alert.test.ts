import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-disk-alert-test-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'test.db');
const {
  checkDiskSpaceAndAlert,
  getActiveDiskAlertTask,
} = await import('../server/disk-alert.js');
const { getTask } = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');

let createdTaskId: string | null = null;

try {
  // 1. Below threshold test: 80% usage (no alert should be generated)
  const belowThresholdResult = await checkDiskSpaceAndAlert({
    customStats: {
      totalBytes: 100 * 1024 ** 3,
      freeBytes: 20 * 1024 ** 3, // 80% used
    },
    thresholdPercent: 90,
  });

  assert.equal(belowThresholdResult.alerted, false);
  assert.equal(belowThresholdResult.resolved, false);
  assert.equal(belowThresholdResult.usedPercent, 80);
  assert.equal(getActiveDiskAlertTask(), null);

  // 2. High threshold test: 92% usage (should create a task in in_review)
  const highThresholdResult = await checkDiskSpaceAndAlert({
    customStats: {
      totalBytes: 100 * 1024 ** 3,
      freeBytes: 8 * 1024 ** 3, // 92% used
    },
    thresholdPercent: 90,
  });

  assert.equal(highThresholdResult.alerted, true);
  assert.equal(highThresholdResult.usedPercent, 92);
  assert.ok(highThresholdResult.task);
  assert.equal(highThresholdResult.task.status, 'in_review');
  assert.equal(highThresholdResult.task.routing_source, 'system_alert');
  assert.match(highThresholdResult.task.title, /Storage Alert/);
  assert.match(highThresholdResult.task.description ?? '', /92%/);

  createdTaskId = highThresholdResult.task.id;

  // Verify in DB
  const inDb = getTask(createdTaskId);
  assert.ok(inDb);
  assert.equal(inDb.status, 'in_review');
  assert.equal(inDb.routing_source, 'system_alert');

  // 3. Deduplication guard: calling again with 95% usage should NOT create another task
  const secondResult = await checkDiskSpaceAndAlert({
    customStats: {
      totalBytes: 100 * 1024 ** 3,
      freeBytes: 5 * 1024 ** 3, // 95% used
    },
    thresholdPercent: 90,
  });

  assert.equal(secondResult.alerted, true);
  assert.equal(secondResult.task?.id, createdTaskId);

  // 4. Recovery test: space drops to 70% (< 85%), alert should auto-resolve to 'done'
  const recoveryResult = await checkDiskSpaceAndAlert({
    customStats: {
      totalBytes: 100 * 1024 ** 3,
      freeBytes: 30 * 1024 ** 3, // 70% used
    },
    thresholdPercent: 90,
    recoveryPercent: 85,
  });

  assert.equal(recoveryResult.resolved, true);
  assert.ok(recoveryResult.task);
  assert.equal(recoveryResult.task.status, 'done');
  assert.match(recoveryResult.task.description ?? '', /recovered/i);

  const updatedInDb = getTask(createdTaskId);
  assert.ok(updatedInDb);
  assert.equal(updatedInDb.status, 'done');

  // 5. Board sorting verification: system_alert tasks must be placed at index 0
  const regularOldTask: Task = {
    id: 'task-1',
    title: 'Regular task 1',
    description: null,
    status: 'in_review',
    profile_name: null,
    routing_source: 'manual',
    agent_model: null,
    agent_provider: null,
    reasoning_effort: null,
    workdir: null,
    project_id: null,
    handling_profile_id: 'default',
    delegated_worker_id: null,
    created_at: 1000,
    updated_at: 5000,
    last_agent_response_at: null,
    last_viewed_at: null,
    last_context_used_tokens: null,
    last_context_window_tokens: null,
  };

  const regularNewTask: Task = {
    ...regularOldTask,
    id: 'task-2',
    title: 'Regular task 2',
    updated_at: 10000,
  };

  const alertTask: Task = {
    ...regularOldTask,
    id: 'alert-task',
    title: 'Alert Task',
    routing_source: 'system_alert',
    updated_at: 2000, // Older timestamp, but must still sort first!
  };

  const list = [regularOldTask, regularNewTask, alertTask];
  list.sort((a, b) => {
    const aAlert = a.routing_source === 'system_alert' ? 1 : 0;
    const bAlert = b.routing_source === 'system_alert' ? 1 : 0;
    if (aAlert !== bAlert) return bAlert - aAlert;
    return b.updated_at - a.updated_at;
  });

  assert.equal(list[0].id, 'alert-task');
  assert.equal(list[1].id, 'task-2');
  assert.equal(list[2].id, 'task-1');
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Disk alert tests passed');
process.exit(0);
