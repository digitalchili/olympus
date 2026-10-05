import db from './index.js';
import { safeRunErrorCode } from '../../shared/run-errors.js';
import type { AgentModelResolution, LiveChatRunStatus, TaskAgentRun, TaskRunKind, RecoveryWaitReason } from '../../shared/types.js';

type AgentRunRow = {
  run_id: string;
  task_id: string;
  kind: TaskRunKind;
  status: LiveChatRunStatus;
  error_code: string | null;
  recovery_state?: string | null;
  recovery_wait_reason?: RecoveryWaitReason | null;
  requested_model: string | null;
  requested_provider: string | null;
  requested_reasoning_effort: AgentModelResolution['requested']['reasoningEffort'];
  actual_model: string | null;
  actual_provider: string | null;
  actual_reasoning_effort: AgentModelResolution['actual']['reasoningEffort'];
  fallback_reason: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
};

const insertRun = db.prepare(`
  INSERT INTO task_agent_runs (run_id, task_id, kind, status, started_at, updated_at)
  VALUES (@runId, @taskId, @kind, @status, @startedAt, @startedAt)
`);
const updateResolution = db.prepare(`
  UPDATE task_agent_runs SET
    requested_model = @requestedModel,
    requested_provider = @requestedProvider,
    requested_reasoning_effort = @requestedReasoningEffort,
    actual_model = @actualModel,
    actual_provider = @actualProvider,
    actual_reasoning_effort = @actualReasoningEffort,
    fallback_reason = @fallbackReason,
    updated_at = @updatedAt
  WHERE run_id = @runId
`);
const finishRun = db.prepare(`
  UPDATE task_agent_runs SET status = @status, completed_at = @completedAt, updated_at = @completedAt,
    error_code = COALESCE(error_code, @errorCode)
  WHERE run_id = @runId AND NOT (status IN ('error', 'stopped') AND @status = 'done')
`);
// One projection for history, board snapshots and recovery status. Waiting is
// current display metadata, never a replacement for the durable recovery cause.
const recoveryProjection = `c.state AS recovery_state,
  CASE WHEN c.state IN ('pending', 'waiting') THEN
    CASE WHEN EXISTS (SELECT 1 FROM task_interactions i WHERE i.task_id = r.task_id
      AND i.olympus_run_id = r.run_id AND i.status NOT IN ('answered', 'denied')) THEN 'awaiting_input'
    WHEN EXISTS (SELECT 1 FROM task_message_queue q WHERE q.task_id = r.task_id) THEN 'queued_message' END
  END AS recovery_wait_reason`;
const latestRun = db.prepare(`
  SELECT r.*, ${recoveryProjection} FROM task_agent_runs r
  LEFT JOIN task_recovery c ON c.task_id = r.task_id AND c.run_id = r.run_id
  WHERE r.task_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
`);

function project(row: AgentRunRow | undefined): TaskAgentRun | undefined {
  if (!row) return undefined;
  const hasResolution = row.requested_model !== null || row.actual_model !== null;
  return {
    runId: row.run_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    recoveryState: row.recovery_state ?? null,
    recoveryWaitReason: row.recovery_wait_reason ?? null,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    modelResolution: hasResolution ? {
      requested: {
        model: row.requested_model,
        provider: row.requested_provider,
        reasoningEffort: row.requested_reasoning_effort,
      },
      actual: {
        model: row.actual_model,
        provider: row.actual_provider,
        reasoningEffort: row.actual_reasoning_effort,
      },
      fallbackReason: row.fallback_reason,
    } : null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function createTaskAgentRun(input: {
  runId: string;
  taskId: string;
  kind: TaskRunKind;
  status: LiveChatRunStatus;
  startedAt: number;
}): void {
  insertRun.run(input);
}

export function hasRecordedTaskAgentRun(runId: string): boolean {
  return !!db.prepare('SELECT 1 FROM task_agent_runs WHERE run_id = ?').get(runId);
}

export function updateTaskAgentRunResolution(runId: string, resolution: AgentModelResolution, updatedAt = Date.now()): void {
  updateResolution.run({
    runId,
    requestedModel: resolution.requested.model,
    requestedProvider: resolution.requested.provider,
    requestedReasoningEffort: resolution.requested.reasoningEffort,
    actualModel: resolution.actual.model,
    actualProvider: resolution.actual.provider,
    actualReasoningEffort: resolution.actual.reasoningEffort,
    fallbackReason: resolution.fallbackReason ?? null,
    updatedAt,
  });
}

export function finishTaskAgentRun(runId: string, status: LiveChatRunStatus, completedAt = Date.now(), errorCode?: string | null): void {
  finishRun.run({ runId, status, completedAt, errorCode: status === 'error'
    ? safeRunErrorCode(errorCode) : status === 'stopped' ? 'run_stopped' : null });
}

/** Startup only, before accepting requests under Olympus's single-writer contract. */
export function recoverInterruptedTaskAgentRuns(now = Date.now()): number {
  return db.prepare(`UPDATE task_agent_runs SET status = 'error', error_code = 'worker_restarted',
    completed_at = ?, updated_at = ? WHERE status IN ('streaming', 'compacting')`).run(now, now).changes;
}

export function getLatestTaskAgentRun(taskId: string): TaskAgentRun | undefined {
  return project(latestRun.get(taskId) as AgentRunRow | undefined);
}

/** Persist terminal outcomes across board reconnects and server restarts. */
export function listLatestTaskAgentRuns(): TaskAgentRun[] {
  const rows = db.prepare(`SELECT r.*, ${recoveryProjection} FROM task_agent_runs r
    LEFT JOIN task_recovery c ON c.task_id = r.task_id AND c.run_id = r.run_id
    WHERE r.rowid = (SELECT rowid FROM task_agent_runs WHERE task_id = r.task_id
      ORDER BY started_at DESC, rowid DESC LIMIT 1)`).all() as AgentRunRow[];
  return rows.map(row => project(row)!);
}
