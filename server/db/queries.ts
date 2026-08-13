import { v4 as uuid } from 'uuid';
import db from './index.js';
import {
  DEFAULT_PROFILE_NAME,
  type Task,
  type TaskStatus,
  type ReasoningEffort,
  type ContextUsage,
  type TaskRoutingSource,
} from '../../shared/types.js';
import { assertProfileAcceptingWork, isProfileDeleting } from '../profile-deletion.js';

const stmtAllTasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC');
const stmtTasksByStatus = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC');
const stmtTasksByProfile = db.prepare('SELECT * FROM tasks WHERE handling_profile_id = ? ORDER BY updated_at DESC');
const stmtTasksByProfileAndStatus = db.prepare('SELECT * FROM tasks WHERE handling_profile_id = ? AND status = ? ORDER BY updated_at DESC');
const stmtDefaultProfileTasks = db.prepare('SELECT * FROM tasks WHERE handling_profile_id = ? ORDER BY updated_at DESC');
const stmtDefaultProfileTasksByStatus = db.prepare('SELECT * FROM tasks WHERE handling_profile_id = ? AND status = ? ORDER BY updated_at DESC');
const stmtTasksByProject = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC');
const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
const stmtInsertTask = db.prepare(`
  INSERT INTO tasks (
    id, title, description, status, profile_name, routing_source, agent_model, agent_provider, reasoning_effort, workdir,
    project_id, handling_profile_id, delegated_worker_id,
    created_at, updated_at, last_agent_response_at, last_viewed_at,
    last_context_used_tokens, last_context_window_tokens
  )
  VALUES (
    @id, @title, @description, @status, @profile_name, @routing_source, @agent_model, @agent_provider, @reasoning_effort, @workdir,
    @project_id, @handling_profile_id, @delegated_worker_id,
    @created_at, @updated_at, @last_agent_response_at, @last_viewed_at,
    @last_context_used_tokens, @last_context_window_tokens
  )
`);
const stmtDeleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
const stmtDeleteTasksByProfile = db.prepare('DELETE FROM tasks WHERE handling_profile_id = ?');
const stmtTouchTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
const stmtMarkTaskViewed = db.prepare(`
  UPDATE tasks
  SET last_viewed_at = last_agent_response_at
  WHERE id = ?
    AND last_agent_response_at IS NOT NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < last_agent_response_at)
`);
const stmtProfileTaskAttention = db.prepare(`
  SELECT handling_profile_id AS profileId, COUNT(*) AS reviewCount
  FROM tasks
  WHERE status = 'in_review'
    AND last_agent_response_at IS NOT NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < last_agent_response_at)
  GROUP BY handling_profile_id
  ORDER BY handling_profile_id
`);

export function getAllTasks(status?: TaskStatus): Task[] {
  return status ? stmtTasksByStatus.all(status) as Task[] : stmtAllTasks.all() as Task[];
}

export function getTasksForProfile(profileId: string, isDefault: boolean, status?: TaskStatus): Task[] {
  if (isDefault) {
    return status
      ? stmtDefaultProfileTasksByStatus.all(profileId, status) as Task[]
      : stmtDefaultProfileTasks.all(profileId) as Task[];
  }
  return status
    ? stmtTasksByProfileAndStatus.all(profileId, status) as Task[]
    : stmtTasksByProfile.all(profileId) as Task[];
}

export function getTasksForProject(projectId: string): Task[] {
  return stmtTasksByProject.all(projectId) as Task[];
}

export function getProfileTaskAttention(): Array<{ profileId: string; reviewCount: number }> {
  return stmtProfileTaskAttention.all() as Array<{ profileId: string; reviewCount: number }>;
}

export function getTask(id: string): Task | undefined {
  return stmtGetTask.get(id) as Task | undefined;
}

export function insertTask(task: {
  title: string;
  description?: string | null;
  status: TaskStatus;
  agent_model?: string | null;
  agent_provider?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  workdir?: string | null;
  profile_name?: string | null;
  project_id?: string | null;
  handling_profile_id?: string | null;
  delegated_worker_id?: string | null;
  routing_source?: TaskRoutingSource | null;
  last_agent_response_at?: number | null;
}): Task {
  const handlingProfileId = task.handling_profile_id ?? task.profile_name ?? DEFAULT_PROFILE_NAME;
  assertProfileAcceptingWork(handlingProfileId);
  const id = uuid();
  const now = Date.now();
  const row = {
    id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    profile_name: task.profile_name === undefined ? handlingProfileId : task.profile_name,
    routing_source: task.routing_source ?? null,
    agent_model: task.agent_model ?? null,
    agent_provider: task.agent_provider ?? null,
    reasoning_effort: task.reasoning_effort ?? null,
    workdir: task.workdir ?? null,
    project_id: task.project_id ?? null,
    handling_profile_id: handlingProfileId,
    delegated_worker_id: task.delegated_worker_id ?? null,
    created_at: now,
    updated_at: now,
    last_agent_response_at: task.last_agent_response_at ?? null,
    last_viewed_at: null,
    last_context_used_tokens: null,
    last_context_window_tokens: null,
  };
  stmtInsertTask.run(row);
  return row as Task;
}

const ALLOWED_UPDATE_FIELDS = new Set<string>([
  'title',
  'description',
  'status',
  'profile_name',
  'handling_profile_id',
  'routing_source',
  'agent_model',
  'agent_provider',
  'reasoning_effort',
  'workdir',
  'last_agent_response_at',
  'last_context_used_tokens',
  'last_context_window_tokens',
]);
const updateStmtCache = new Map<string, ReturnType<typeof db.prepare>>();

type TaskUpdateFields = Pick<
  Task,
  | 'title'
  | 'description'
  | 'status'
  | 'profile_name'
  | 'handling_profile_id'
  | 'routing_source'
  | 'agent_model'
  | 'agent_provider'
  | 'reasoning_effort'
  | 'workdir'
  | 'last_agent_response_at'
  | 'last_context_used_tokens'
  | 'last_context_window_tokens'
>;

function getUpdateStmt(fieldKeys: string[]): ReturnType<typeof db.prepare> {
  const key = fieldKeys.join(',');
  let stmt = updateStmtCache.get(key);
  if (!stmt) {
    const sets = fieldKeys.map(f => `${f} = @${f}`).join(', ');
    stmt = db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`);
    updateStmtCache.set(key, stmt);
  }
  return stmt;
}

export function updateTask(
  id: string,
  inputFields: Partial<TaskUpdateFields>,
): Task | undefined {
  const current = getTask(id);
  if (!current || isProfileDeleting(current.handling_profile_id ?? current.profile_name ?? DEFAULT_PROFILE_NAME)) return undefined;
  const fields = { ...inputFields };
  if (fields.profile_name !== undefined || fields.handling_profile_id !== undefined) {
    const nextHandler = fields.handling_profile_id ?? fields.profile_name ?? DEFAULT_PROFILE_NAME;
    assertProfileAcceptingWork(nextHandler);
    fields.profile_name = fields.profile_name ?? nextHandler;
    fields.handling_profile_id = nextHandler;
  }
  const fieldKeys: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    fieldKeys.push(key);
    values[key] = value ?? null;
  }

  if (fieldKeys.length === 0) return getTask(id);

  values.updated_at = Date.now();
  getUpdateStmt(fieldKeys).run(values);
  return getTask(id);
}

export function touchTask(id: string): void {
  const task = getTask(id);
  if (!task || isProfileDeleting(task.handling_profile_id ?? task.profile_name ?? DEFAULT_PROFILE_NAME)) return;
  stmtTouchTask.run(Date.now(), id);
}

export function contextFromTask(task: Task): ContextUsage | null {
  if (task.last_context_used_tokens == null || task.last_context_window_tokens == null) return null;
  return { used_tokens: task.last_context_used_tokens, window_tokens: task.last_context_window_tokens };
}

export function recordAgentResponse(taskId: string, at = Date.now(), context?: ContextUsage | null): Task | undefined {
  return updateTask(taskId, {
    last_agent_response_at: at,
    ...(context !== undefined ? {
      last_context_used_tokens: context?.used_tokens ?? null,
      last_context_window_tokens: context?.window_tokens ?? null,
    } : {}),
  });
}

export function markTaskViewed(id: string): { task: Task | undefined; changed: boolean } {
  const current = getTask(id);
  if (!current || isProfileDeleting(current.handling_profile_id ?? current.profile_name ?? DEFAULT_PROFILE_NAME)) {
    return { task: current, changed: false };
  }
  const result = stmtMarkTaskViewed.run(id);
  return {
    task: getTask(id),
    changed: result.changes > 0,
  };
}

export function deleteTask(id: string): boolean {
  const task = getTask(id);
  if (!task || isProfileDeleting(task.handling_profile_id ?? task.profile_name ?? DEFAULT_PROFILE_NAME)) return false;
  const result = stmtDeleteTask.run(id);
  return result.changes > 0;
}

export function deleteTasksForProfile(profileId: string): string[] {
  const taskIds = (stmtTasksByProfile.all(profileId) as Task[]).map((task) => task.id);
  stmtDeleteTasksByProfile.run(profileId);
  return taskIds;
}
