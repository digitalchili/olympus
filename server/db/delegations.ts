import { randomUUID } from 'node:crypto';
import type { DelegationRun, DelegationRunStatus, DelegationWorkerEvent } from '../../shared/types.js';
import db from './index.js';

const TERMINAL = new Set<DelegationRunStatus>([
  'stalled', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown',
]);

type RecordInput = {
  profileId: string;
  taskId: string;
  event: DelegationWorkerEvent;
  receivedAt?: number;
};

function row(value: unknown): DelegationRun {
  return value as DelegationRun;
}

export function listDelegationRuns(taskId: string, profileId?: string): DelegationRun[] {
  if (profileId) {
    return db.prepare(
      `SELECT * FROM (
        SELECT * FROM delegation_runs WHERE task_id = ? AND profile_name = ? ORDER BY updated_at DESC LIMIT 200
      ) ORDER BY created_at ASC, child_index ASC`,
    ).all(taskId, profileId).map(row);
  }
  return db.prepare(
    `SELECT * FROM (
      SELECT * FROM delegation_runs WHERE task_id = ? ORDER BY updated_at DESC LIMIT 200
    ) ORDER BY created_at ASC, child_index ASC`,
  ).all(taskId).map(row);
}

export function listDelegationRunsForProfile(profileId: string): DelegationRun[] {
  return db.prepare(
    `SELECT * FROM (
      SELECT * FROM delegation_runs WHERE profile_name = ? ORDER BY updated_at DESC LIMIT 500
    ) ORDER BY updated_at ASC`,
  ).all(profileId).map(row);
}

export function recordDelegationEvent(input: RecordInput): DelegationRun | null {
  const existing = db.prepare(
    'SELECT * FROM delegation_runs WHERE child_id = ?',
  ).get(input.event.childId) as DelegationRun | undefined;

  const receivedAt = Math.max(0, Math.floor(input.receivedAt ?? Date.now()));
  const now = input.receivedAt === undefined && existing
    ? Math.max(receivedAt, existing.updated_at + 1)
    : receivedAt;

  if (existing && (
    existing.task_id !== input.taskId ||
    existing.delegation_id !== input.event.delegationId ||
    existing.parent_session_id !== input.event.parentSessionId
  )) return null;

  if (existing && now < existing.updated_at) return existing;

  const nextStatus = input.event.status;
  if (existing && TERMINAL.has(existing.status)) {
    const provenTerminalAfterUnknown = existing.status === 'unknown' && TERMINAL.has(nextStatus) && nextStatus !== 'unknown';
    if (!provenTerminalAfterUnknown) return existing;
  }

  const startedAt = existing?.started_at ?? (nextStatus === 'queued' ? null : now);
  const completedAt = TERMINAL.has(nextStatus)
    ? (existing?.status === 'unknown' && nextStatus !== 'unknown' ? now : (existing?.completed_at ?? now))
    : null;
  const id = existing?.id ?? randomUUID();
  const createdAt = existing?.created_at ?? now;

  db.prepare(`
    INSERT INTO delegation_runs (
      id, profile_name, task_id, parent_session_id, delegation_id, child_id,
      child_session_id, parent_child_id, child_index, child_count, status,
      current_action, model, tool_count, api_calls, duration_seconds,
      input_tokens, output_tokens, reasoning_tokens, cost_usd, files_touched,
      created_at, started_at, last_activity_at, completed_at, updated_at
    ) VALUES (
      @id, @profile_name, @task_id, @parent_session_id, @delegation_id, @child_id,
      @child_session_id, @parent_child_id, @child_index, @child_count, @status,
      @current_action, @model, @tool_count, @api_calls, @duration_seconds,
      @input_tokens, @output_tokens, @reasoning_tokens, @cost_usd, @files_touched,
      @created_at, @started_at, @last_activity_at, @completed_at, @updated_at
    ) ON CONFLICT(child_id) DO UPDATE SET
      child_session_id = excluded.child_session_id,
      parent_child_id = excluded.parent_child_id,
      child_index = excluded.child_index,
      child_count = excluded.child_count,
      status = excluded.status,
      current_action = excluded.current_action,
      model = excluded.model,
      tool_count = MAX(delegation_runs.tool_count, excluded.tool_count),
      api_calls = MAX(delegation_runs.api_calls, excluded.api_calls),
      duration_seconds = COALESCE(excluded.duration_seconds, delegation_runs.duration_seconds),
      input_tokens = MAX(delegation_runs.input_tokens, excluded.input_tokens),
      output_tokens = MAX(delegation_runs.output_tokens, excluded.output_tokens),
      reasoning_tokens = MAX(delegation_runs.reasoning_tokens, excluded.reasoning_tokens),
      cost_usd = COALESCE(excluded.cost_usd, delegation_runs.cost_usd),
      files_touched = MAX(delegation_runs.files_touched, excluded.files_touched),
      started_at = COALESCE(delegation_runs.started_at, excluded.started_at),
      last_activity_at = MAX(delegation_runs.last_activity_at, excluded.last_activity_at),
      completed_at = CASE
        WHEN delegation_runs.status = 'unknown' AND excluded.status <> 'unknown' THEN excluded.completed_at
        ELSE COALESCE(delegation_runs.completed_at, excluded.completed_at)
      END,
      updated_at = MAX(delegation_runs.updated_at, excluded.updated_at)
  `).run({
    id,
    profile_name: input.profileId,
    task_id: input.taskId,
    parent_session_id: input.event.parentSessionId,
    delegation_id: input.event.delegationId,
    child_id: input.event.childId,
    child_session_id: input.event.childSessionId,
    parent_child_id: input.event.parentChildId,
    child_index: input.event.childIndex,
    child_count: input.event.childCount,
    status: nextStatus,
    current_action: TERMINAL.has(nextStatus) ? null : input.event.currentAction,
    model: input.event.model,
    tool_count: input.event.toolCount,
    api_calls: input.event.apiCalls,
    duration_seconds: input.event.durationSeconds,
    input_tokens: input.event.inputTokens,
    output_tokens: input.event.outputTokens,
    reasoning_tokens: input.event.reasoningTokens,
    cost_usd: input.event.costUsd,
    files_touched: input.event.filesTouched,
    created_at: createdAt,
    started_at: startedAt,
    last_activity_at: now,
    completed_at: completedAt,
    updated_at: now,
  });

  return db.prepare('SELECT * FROM delegation_runs WHERE id = ?').get(id) as DelegationRun;
}

export function markUnprovenDelegationsUnknown(at = Date.now()): number {
  const result = db.prepare(`
    UPDATE delegation_runs
    SET status = 'unknown',
        current_action = NULL,
        completed_at = MAX(updated_at + 1, ?),
        updated_at = MAX(updated_at + 1, ?)
    WHERE status IN ('queued', 'running', 'waiting')
  `).run(at, at);
  return result.changes;
}

export function markProfileDelegationsUnknown(profileId: string, at = Date.now()): DelegationRun[] {
  const active = db.prepare(`
    SELECT id FROM delegation_runs
    WHERE profile_name = ? AND status IN ('queued', 'running', 'waiting')
  `).all(profileId) as Array<{ id: string }>;
  if (active.length === 0) return [];

  db.prepare(`
    UPDATE delegation_runs
    SET status = 'unknown',
        current_action = NULL,
        completed_at = MAX(updated_at + 1, ?),
        updated_at = MAX(updated_at + 1, ?)
    WHERE profile_name = ? AND status IN ('queued', 'running', 'waiting')
  `).run(at, at, profileId);

  const getById = db.prepare('SELECT * FROM delegation_runs WHERE id = ?');
  return active.map(({ id }) => getById.get(id) as DelegationRun);
}
