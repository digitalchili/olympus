import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'run-failure-'));
process.env.DB_PATH = join(root, 'state.db');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { createTaskAgentRun, finishTaskAgentRun, getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
try {
  const task = insertTask({ title: 'Interrupted implementation', status: 'in_progress' });
  createTaskAgentRun({runId:'failed-run',taskId:task.id,kind:'chat',status:'streaming',startedAt:100});
  finishTaskAgentRun('failed-run','error',200,'run_runtime_timeout');
  assert.equal(getLatestTaskAgentRun(task.id)?.errorCode, 'run_runtime_timeout', 'typed failure survives live snapshot expiry');
  finishTaskAgentRun('failed-run','done',210);
  assert.equal(getLatestTaskAgentRun(task.id)?.status, 'error', 'late success cannot overwrite terminal error');
  assert.equal(getLatestTaskAgentRun(task.id)?.errorCode, 'run_runtime_timeout');
  createTaskAgentRun({runId:'retry-run',taskId:task.id,kind:'chat',status:'streaming',startedAt:300});
  finishTaskAgentRun('retry-run','done',400);
  assert.equal(getLatestTaskAgentRun(task.id)?.status, 'done');
  assert.equal(getLatestTaskAgentRun(task.id)?.errorCode ?? null, null, 'new success does not inherit old error');
} finally { db.close(); rmSync(root,{recursive:true,force:true}); }
console.log('Task failure persistence tests passed');
