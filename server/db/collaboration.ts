import { v4 as uuid } from 'uuid';
import db from './index.js';
import type {
  CollaborationContribution,
  CollaborationContributionPhase,
  CollaborationContributionStatus,
  CollaborationRun,
  CollaborationRunStatus,
  PersistentCollaborationGrant,
} from '../../shared/types.js';

type RunRow = Omit<CollaborationRun, 'owner_invited' | 'contributions'> & { owner_invited: number };

const ACTIVE_RUN_STATUSES: CollaborationRunStatus[] = ['gathering', 'proposal', 'review', 'synthesizing'];
const activeStatusSql = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
const getRunStatement = db.prepare('SELECT * FROM collaboration_runs WHERE id = ?');
const listRunsStatement = db.prepare('SELECT * FROM collaboration_runs WHERE task_id = ? ORDER BY round DESC');
const listContributionsStatement = db.prepare(
  'SELECT * FROM collaboration_contributions WHERE run_id = ? ORDER BY phase_round, started_at, profile_label',
);
const nextRoundStatement = db.prepare(
  'SELECT COALESCE(MAX(round), 0) + 1 AS round FROM collaboration_runs WHERE task_id = ?',
);
const insertRunStatement = db.prepare(`
  INSERT INTO collaboration_runs (
    id, task_id, round, status, question, owner_profile_id, owner_invited,
    created_at, contributors_completed_at, completed_at
  ) VALUES (
    @id, @task_id, @round, @status, @question, @owner_profile_id, @owner_invited,
    @created_at, NULL, NULL
  )
`);
const insertContributionStatement = db.prepare(`
  INSERT INTO collaboration_contributions (
    id, run_id, profile_id, profile_label, session_id, phase, phase_round, status,
    content, error, started_at, completed_at
  ) VALUES (
    @id, @run_id, @profile_id, @profile_label, @session_id, @phase, @phase_round, @status,
    NULL, NULL, @started_at, NULL
  )
`);
const updateContributionStatement = db.prepare(`
  UPDATE collaboration_contributions
  SET status = @status, content = @content, error = @error, completed_at = @completed_at
  WHERE id = @id AND status = 'running'
    AND EXISTS (
      SELECT 1 FROM collaboration_runs
      WHERE collaboration_runs.id = collaboration_contributions.run_id
        AND collaboration_runs.status IN ('proposal', 'review')
    )
`);
const updateRunStatement = db.prepare(`
  UPDATE collaboration_runs
  SET status = @status,
      contributors_completed_at = COALESCE(@contributors_completed_at, contributors_completed_at),
      completed_at = COALESCE(@completed_at, completed_at)
  WHERE id = @id
    AND status IN ('gathering', 'proposal', 'review', 'synthesizing')
`);

function hydrateRun(row: RunRow): CollaborationRun {
  return {
    ...row,
    owner_invited: row.owner_invited === 1,
    contributions: listContributionsStatement.all(row.id) as CollaborationContribution[],
  };
}

export function isActiveCollaborationStatus(status: CollaborationRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export function getCollaborationRun(id: string): CollaborationRun | undefined {
  const row = getRunStatement.get(id) as RunRow | undefined;
  return row ? hydrateRun(row) : undefined;
}

export function listCollaborationRuns(taskId: string): CollaborationRun[] {
  return (listRunsStatement.all(taskId) as RunRow[]).map(hydrateRun);
}

export function createCollaborationRun(input: {
  taskId: string;
  question: string;
  ownerProfileId: string;
  ownerInvited: boolean;
  participants: Array<{ id: string; label: string }>;
}): CollaborationRun {
  const create = db.transaction(() => {
    const id = uuid();
    const now = Date.now();
    const round = (nextRoundStatement.get(input.taskId) as { round: number }).round;
    insertRunStatement.run({
      id,
      task_id: input.taskId,
      round,
      status: 'proposal',
      question: input.question,
      owner_profile_id: input.ownerProfileId,
      owner_invited: input.ownerInvited ? 1 : 0,
      created_at: now,
    });
    const phases: CollaborationContributionPhase[] = input.participants.length >= 2
      ? ['proposal', 'review']
      : ['proposal'];
    for (const participant of input.participants) {
      for (const phase of phases) {
        insertContributionStatement.run({
          id: uuid(),
          run_id: id,
          profile_id: participant.id,
          profile_label: participant.label,
          session_id: `collaboration-${id}-${phase}-${uuid()}`,
          phase,
          phase_round: phase === 'proposal' ? 1 : 2,
          status: phase === 'proposal' ? 'running' : 'pending',
          started_at: now,
        });
      }
    }
    return id;
  });

  return getCollaborationRun(create())!;
}

export function startCollaborationPhase(
  id: string,
  phase: CollaborationContributionPhase,
): CollaborationRun | undefined {
  const start = db.transaction(() => {
    const run = getRunStatement.get(id) as RunRow | undefined;
    if (!run || !isActiveCollaborationStatus(run.status)) return false;
    const status: CollaborationRunStatus = phase;
    updateRunStatement.run({
      id,
      status,
      contributors_completed_at: null,
      completed_at: null,
    });
    db.prepare(`
      UPDATE collaboration_contributions
      SET status = 'running', started_at = ?, completed_at = NULL, error = NULL
      WHERE run_id = ? AND phase = ? AND status = 'pending'
    `).run(Date.now(), id, phase);
    return true;
  });
  return start() ? getCollaborationRun(id) : undefined;
}

export function completeCollaborationContribution(
  id: string,
  result: { status: Extract<CollaborationContributionStatus, 'completed' | 'error'>; content?: string | null; error?: string | null },
): boolean {
  return updateContributionStatement.run({
    id,
    status: result.status,
    content: result.content ?? null,
    error: result.error ?? null,
    completed_at: Date.now(),
  }).changes > 0;
}

export function updateCollaborationRun(
  id: string,
  status: CollaborationRunStatus,
  timestamps: { contributorsCompleted?: boolean; completed?: boolean } = {},
): CollaborationRun | undefined {
  const now = Date.now();
  updateRunStatement.run({
    id,
    status,
    contributors_completed_at: timestamps.contributorsCompleted ? now : null,
    completed_at: timestamps.completed ? now : null,
  });
  return getCollaborationRun(id);
}

export function cancelCollaborationRun(id: string, reason = 'Stopped by user'): CollaborationRun | undefined {
  const cancel = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE collaboration_runs
      SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
      WHERE id = ? AND status IN (${activeStatusSql})
    `).run(Date.now(), id, ...ACTIVE_RUN_STATUSES).changes;
    if (!changed) return false;
    db.prepare(`
      UPDATE collaboration_contributions
      SET status = 'cancelled', error = COALESCE(error, ?), completed_at = COALESCE(completed_at, ?)
      WHERE run_id = ? AND status IN ('pending', 'running')
    `).run(reason, Date.now(), id);
    return true;
  });
  return cancel() ? getCollaborationRun(id) : undefined;
}

type PersistentScope = PersistentCollaborationGrant['scope'];
type GrantRow = {
  scope_id: string;
  profile_id: string;
  granted_by: string;
  created_at: number;
  updated_at: number;
};

function grantTable(scope: PersistentScope): { table: string; idColumn: string } {
  return scope === 'task'
    ? { table: 'task_collaboration_grants', idColumn: 'task_id' }
    : { table: 'project_collaboration_grants', idColumn: 'project_id' };
}

function grantFromRow(scope: PersistentScope, row: GrantRow): PersistentCollaborationGrant {
  return {
    scope,
    scopeId: row.scope_id,
    profileId: row.profile_id,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function grantPersistentCollaboration(input: {
  scope: PersistentScope;
  scopeId: string;
  profileId: string;
  grantedBy: string;
}, now = Date.now()): PersistentCollaborationGrant {
  const { table, idColumn } = grantTable(input.scope);
  db.prepare(`
    INSERT INTO ${table} (${idColumn}, profile_id, granted_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(${idColumn}, profile_id) DO UPDATE SET
      granted_by = excluded.granted_by,
      updated_at = excluded.updated_at
  `).run(input.scopeId, input.profileId, input.grantedBy, now, now);
  const row = db.prepare(`
    SELECT ${idColumn} AS scope_id, profile_id, granted_by, created_at, updated_at
    FROM ${table} WHERE ${idColumn} = ? AND profile_id = ?
  `).get(input.scopeId, input.profileId) as GrantRow;
  return grantFromRow(input.scope, row);
}

export function listPersistentCollaborationGrants(input: {
  taskId: string;
  projectId?: string | null;
}): PersistentCollaborationGrant[] {
  const taskRows = db.prepare(`
    SELECT task_id AS scope_id, profile_id, granted_by, created_at, updated_at
    FROM task_collaboration_grants WHERE task_id = ? ORDER BY profile_id
  `).all(input.taskId) as GrantRow[];
  const grants = taskRows.map((row) => grantFromRow('task', row));
  if (input.projectId) {
    const projectRows = db.prepare(`
      SELECT project_id AS scope_id, profile_id, granted_by, created_at, updated_at
      FROM project_collaboration_grants WHERE project_id = ? ORDER BY profile_id
    `).all(input.projectId) as GrantRow[];
    grants.push(...projectRows.map((row) => grantFromRow('project', row)));
  }
  return grants;
}

export function revokePersistentCollaborationGrant(
  scope: PersistentScope,
  scopeId: string,
  profileId: string,
): boolean {
  const { table, idColumn } = grantTable(scope);
  return db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ? AND profile_id = ?`)
    .run(scopeId, profileId).changes > 0;
}
