import { broadcast } from './events.js';
import db from './db/index.js';
import { getTask } from './db/queries.js';
import { getLatestTaskAgentRun } from './db/task-agent-runs.js';
import { getRunStatus } from './live-chat.js';
import type { AgentAdapter } from './adapters/types.js';

export interface RecoveryRecord {
  task_id: string; run_id: string; started_at: number; deadline_at: number; attempts: number;
  state: 'running' | 'pending' | 'waiting' | 'dispatching' | 'blocked' | 'complete' | 'exhausted';
  reason: string | null; checkpoint_json: string | null;
}
const recoverable = new Set(['iteration_limit', 'run_idle_timeout', 'run_runtime_timeout', 'deadline_finalized', 'worker_restarted', 'stream_incomplete', 'recovery_pending']);
export function getRecovery(taskId: string): RecoveryRecord | undefined {
  return db.prepare('SELECT * FROM task_recovery WHERE task_id = ?').get(taskId) as RecoveryRecord | undefined;
}
export function beginRecovery(taskId: string, runId: string, at: number, automatic = false): void {
  if (automatic) {
    db.prepare("UPDATE task_recovery SET run_id = ?, state = 'running', reason = NULL WHERE task_id = ? AND state = 'dispatching'").run(runId, taskId);
  } else {
    db.prepare(`INSERT INTO task_recovery (task_id, run_id, started_at, deadline_at, attempts, state)
      VALUES (?, ?, ?, ?, 0, 'running') ON CONFLICT(task_id) DO UPDATE SET run_id=excluded.run_id,
      started_at=excluded.started_at, deadline_at=excluded.deadline_at, attempts=0, state='running', reason=NULL, checkpoint_json=NULL`)
      .run(taskId, runId, at, at + 2 * 60 * 60_000);
  }
}
export function recoveryOutcome(taskId: string, runId: string, status: string, code?: string | null): void {
  const state = status === 'done' ? 'complete' : status === 'error' && recoverable.has(code ?? '') ? 'pending' : 'blocked';
  db.prepare("UPDATE task_recovery SET state = ?, reason = ? WHERE task_id = ? AND run_id = ? AND state <> 'blocked'").run(state, code ?? null, taskId, runId);
  broadcastRecovery(taskId);
}
export function cancelRecovery(taskId: string, reason = 'Stopped by user'): void {
  db.prepare("UPDATE task_recovery SET state = 'blocked', reason = ? WHERE task_id = ?").run(reason, taskId);
  broadcastRecovery(taskId);
}
export function saveRecoveryCheckpoint(taskId: string, runId: string, checkpoint: unknown): void {
  const value = JSON.stringify(checkpoint);
  if (value.length > 16_000) return;
  db.prepare('UPDATE task_recovery SET checkpoint_json = ? WHERE task_id = ? AND run_id = ?').run(value, taskId, runId);
}
export function recoverRecoveryRecords(): void {
  db.prepare(`UPDATE task_recovery SET state='pending', reason='worker_restarted'
    WHERE state='dispatching' OR (state='running' AND run_id IN (SELECT run_id FROM task_agent_runs WHERE status='error' AND error_code='worker_restarted'))`).run();
}
function broadcastRecovery(taskId: string): void {
  const run = getLatestTaskAgentRun(taskId);
  if (run) broadcast({ type: 'task_run_updated', run });
}
let reconciling = false;
export async function reconcileRecoveries(
  adapter: Pick<AgentAdapter, 'getBackgroundWork'>,
  deliver: (taskId: string, runId: string) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const rows = db.prepare("SELECT * FROM task_recovery WHERE state IN ('pending','waiting')").all() as RecoveryRecord[];
    for (const row of rows) {
      const latest = getLatestTaskAgentRun(row.task_id);
      if (!latest || latest.runId !== row.run_id || latest.status !== 'error' || getRunStatus(row.task_id)?.status === 'streaming') continue;
      if (!getTask(row.task_id) || !recoverable.has(latest.errorCode ?? '')) continue;
      if (row.attempts >= 2 || now >= row.deadline_at) {
        db.prepare("UPDATE task_recovery SET state='exhausted', reason='Automatic recovery budget exhausted; review unfinished work' WHERE task_id=? AND run_id=?").run(row.task_id, row.run_id);
        broadcastRecovery(row.task_id);
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const inventory = await Promise.race([
          adapter.getBackgroundWork?.(row.task_id) ?? Promise.resolve({ available: false, work: [], continuation: undefined }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Inventory unavailable')), 5_000); }),
        ]);
        const current = getRecovery(row.task_id);
        if (!current || current.run_id !== row.run_id || !['pending','waiting'].includes(current.state)) continue;
        if (!inventory.available || inventory.work.length || inventory.continuation?.status !== 'pending') {
          const blocked = inventory.continuation?.status === 'blocked';
          db.prepare('UPDATE task_recovery SET state=?, reason=? WHERE task_id=? AND run_id=?').run(blocked ? 'blocked' : 'waiting', inventory.continuation?.reason ?? (inventory.work.length ? 'Waiting for owned background work' : 'Waiting for recoverable continuation evidence'), row.task_id, row.run_id);
          continue;
        }
        const claimed = db.prepare("UPDATE task_recovery SET state='dispatching', attempts=attempts+1 WHERE task_id=? AND run_id=? AND state IN ('pending','waiting')").run(row.task_id, row.run_id);
        if (!claimed.changes) continue;
        await deliver(row.task_id, row.run_id);
      } catch {
        db.prepare("UPDATE task_recovery SET state='waiting', reason='Recovery check or startup failed; will retry within budget' WHERE task_id=? AND run_id=? AND state <> 'blocked'").run(row.task_id, row.run_id);
      } finally {
        if (timer) clearTimeout(timer);
        const current = getRecovery(row.task_id);
        if (current?.state !== row.state || current?.attempts !== row.attempts) broadcastRecovery(row.task_id);
      }
    }
  } finally { reconciling = false; }
}
