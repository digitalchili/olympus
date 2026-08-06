import assert from 'node:assert/strict';
import type { DelegationRun } from '../shared/types.js';
import {
  applyDelegationRunUpdate,
  summarizeDelegationActivity,
} from '../client/src/lib/delegationActivity.js';

const base: DelegationRun = {
  id: 'row-1',
  profile_name: 'default',
  task_id: 'task-1',
  parent_session_id: 'task-1',
  delegation_id: 'deleg-1',
  child_id: 'child-1',
  child_session_id: 'session-child-1',
  parent_child_id: null,
  child_index: 0,
  child_count: 2,
  status: 'running',
  current_action: 'web_search',
  model: 'gpt-5.6-sol',
  tool_count: 2,
  api_calls: 1,
  duration_seconds: null,
  input_tokens: 10,
  output_tokens: 4,
  reasoning_tokens: 2,
  cost_usd: null,
  files_touched: 0,
  created_at: 100,
  started_at: 100,
  last_activity_at: 200,
  completed_at: null,
  updated_at: 200,
};

const second: DelegationRun = {
  ...base,
  id: 'row-2',
  child_id: 'child-2',
  child_session_id: 'session-child-2',
  child_index: 1,
  status: 'waiting',
  current_action: null,
  updated_at: 210,
};

const summary = summarizeDelegationActivity([base, second]);
assert.equal(summary.activeCount, 2);
assert.equal(summary.totalCount, 2);
assert.equal(summary.title, '2 delegated workers active');

const completed = { ...base, status: 'completed' as const, updated_at: 300, completed_at: 300 };
const applied = applyDelegationRunUpdate([base, second], completed);
assert.equal(applied.length, 2);
assert.equal(applied.find((run) => run.id === base.id)?.status, 'completed');

const stale = applyDelegationRunUpdate(applied, { ...base, updated_at: 250 });
assert.equal(stale.find((run) => run.id === base.id)?.status, 'completed', 'client ignores stale SSE updates');
assert.deepEqual(
  applyDelegationRunUpdate(stale, completed),
  stale,
  'duplicate SSE updates are idempotent',
);

console.log('Delegation activity client reducer tests passed');
