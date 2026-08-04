export const TASK_STATUSES = ['in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AppVersion {
  name: string;
  version: string;
}

export const CHAT_RUN_MODES = ['task', 'goal'] as const;
export type ChatRunMode = (typeof CHAT_RUN_MODES)[number];
export const MINIONS_GOAL_MAX_TURNS = 20;

export interface AgentRunSettings {
  model?: string | null;
  provider?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: ChatRunMode;
}

export const DEFAULT_PROFILE_NAME = 'default';

export const TASK_HANDOFF_STATES = ['created', 'running', 'completed', 'failed', 'cancelled'] as const;
export type TaskHandoffState = (typeof TASK_HANDOFF_STATES)[number];
// `automatic` remains readable for tasks created by older Olympus versions.
export const TASK_ROUTING_SOURCES = ['manual', 'automatic'] as const;
export type TaskRoutingSource = (typeof TASK_ROUTING_SOURCES)[number];

export interface HermesProfileCapabilities {
  settings: boolean;
  soul: boolean;
  workspace: boolean;
  skills: boolean;
  scheduledTasks: boolean;
}

export interface HermesProfileHealth {
  status: 'ready' | 'degraded';
  issues: string[];
}

export interface HermesProfile {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  capabilities: HermesProfileCapabilities;
  health: HermesProfileHealth;
}

export interface HermesProfileSettings {
  id: string;
  displayName: string;
  description: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: ReasoningEffort | null;
  soul: string;
}

export type HermesProfileSettingsUpdate = Partial<Omit<HermesProfileSettings, 'id'>>;

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  profile_name: string | null;
  routing_source: TaskRoutingSource | null;
  agent_model: string | null;
  agent_provider: string | null;
  reasoning_effort: ReasoningEffort | null;
  workdir: string | null;
  created_at: number;
  updated_at: number;
  last_agent_response_at: number | null;
  last_viewed_at: number | null;
  last_context_used_tokens: number | null;
  last_context_window_tokens: number | null;
  handoff_parent_task_id?: string | null;
  handoff_child_task_id?: string | null;
  handoff_state?: TaskHandoffState | null;
  handoff_route?: string | null;
}

export interface TaskHandoff {
  id: string;
  parent_task_id: string;
  child_task_id: string;
  route: string;
  state: TaskHandoffState;
  created_at: number;
  updated_at: number;
}

export interface TaskHandoffWithTasks extends TaskHandoff {
  parent_task: Task | null;
  child_task: Task | null;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at: number;
  completed_at?: number;
}

export interface ToolProgressEvent {
  tool: string;
  status: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
}

export type TaskRunKind = 'chat' | 'goal' | 'compact';
export type LiveChatRunStatus = 'streaming' | 'compacting' | 'done' | 'error' | 'stopped';

export interface TaskRunState {
  taskId: string;
  runId: string;
  kind: TaskRunKind;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
  goal?: GoalStateSnapshot | null;
}

export type BoardEvent =
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'task_runs_snapshot'; runs: TaskRunState[] }
  | { type: 'task_run_updated'; run: TaskRunState };

export type LiveChatMessage = TaskMessage & { tools?: ToolProgressEvent[] };

export interface LiveChatRun {
  taskId: string;
  runId: string;
  kind: TaskRunKind;
  sessionId: string;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
  messages: LiveChatMessage[];
  goal?: GoalStateSnapshot | null;
  context?: ContextUsage | null;
  error?: string;
}

export interface ContextUsage {
  used_tokens: number;
  window_tokens: number;
}

export interface CompactResult {
  compressed: boolean;
  sessionId: string;
  previousMessageCount: number;
  compressedMessageCount: number;
  context?: ContextUsage | null;
}

export interface GoalStateSnapshot {
  goal: string;
  status: 'active' | 'paused' | 'done' | 'cleared';
  turnsUsed: number;
  maxTurns: number;
  lastReason?: string | null;
  pausedReason?: string | null;
}

export interface GoalDecision {
  status: GoalStateSnapshot['status'] | null;
  shouldContinue: boolean;
  continuationPrompt?: string | null;
  verdict: 'done' | 'continue' | 'skipped' | 'inactive';
  reason: string;
  message: string;
  state?: GoalStateSnapshot | null;
}

export interface SessionMetadata {
  id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: string | null;
  model: string | null;
}

export interface AgentDefaults {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiMode: string | null;
  reasoningEffort: ReasoningEffort | null;
  showReasoning: boolean;
}

export interface AgentModelOption {
  id: string;
  label: string;
  source: 'current' | 'catalog' | 'custom' | 'alias';
  provider?: string | null;
  isCurrentDefault?: boolean;
}

export interface AgentModelGroup {
  provider: string;
  models: AgentModelOption[];
}

export interface AgentModelsResponse {
  defaultModel: string | null;
  activeProvider: string | null;
  groups: AgentModelGroup[];
}

export interface TaskAgentSettings {
  task: {
    model: string | null;
    provider: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
  defaults: AgentDefaults;
  effective: {
    model: string | null;
    provider: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
}

export interface ScheduledTaskOrigin {
  platform?: string | null;
  chat_id?: string | null;
  chat_name?: string | null;
  thread_id?: string | null;
  [key: string]: unknown;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string | null;
  schedule: Record<string, unknown> | null;
  scheduleDisplay: string | null;
  enabled: boolean;
  state: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduledTaskStatus | null;
  lastError: string | null;
  lastDeliveryError: string | null;
  model: string | null;
  provider: string | null;
  baseUrl: string | null;
  deliver: string | null;
  origin: ScheduledTaskOrigin | null;
  repeat: ScheduledTaskRepeat | null;
  contextFrom: string[];
  skills: string[];
  workdir: string | null;
  createdAt: string | null;
}

export type ScheduledTaskStatus = 'ok' | 'error' | 'unknown';

export interface ScheduledTaskRepeat {
  times: number | null;
  completed: number;
}

export interface ScheduledTaskRun {
  id: string;
  scheduledTaskId: string;
  ranAt: string | null;
  path: string;
  status: ScheduledTaskStatus;
  preview: string;
}

export interface ScheduledTaskRunContent {
  body: string;
  status: ScheduledTaskStatus;
}

export interface ScheduledTaskInput {
  name?: string;
  prompt: string;
  schedule: string;
  deliver?: string;
  skills?: string[];
  model?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
  workdir?: string | null;
  repeat?: number | null;
  contextFrom?: string | string[] | null;
}

export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  displayPath: string;
  type: FileEntryType;
  hidden: boolean;
  size: number | null;
  modifiedAt: number | null;
  readable: boolean;
  writable: boolean;
}

export interface FileListResponse {
  path: string;
  displayPath: string;
  parentPath: string | null;
  entries: FileEntry[];
}

export interface FileReadResponse {
  path: string;
  displayPath: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: number;
  encoding: 'utf8';
  fileType: 'text';
}

export interface FileWriteResponse {
  path: string;
  displayPath: string;
  size: number;
  modifiedAt: number;
}

export type FileCreateType = 'file' | 'directory';

export interface FileCreateResponse {
  entry: FileEntry;
}

export interface FileRenameResponse {
  entry: FileEntry;
}

export interface FileDeleteResponse {
  ok: true;
}

export interface FileUploadResponse {
  uploaded: number;
  entries: FileEntry[];
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  key: string;
  source: string;
  provider?: string;
  registrySlug?: string;
  registryOwnerHandle?: string;
  sourceUrl?: string;
  version?: string;
  installedAt?: string;
}

export interface SkillInstallResult {
  skill: SkillMeta;
  installed: boolean;
  alreadyInstalled?: boolean;
}

export interface ClawHubStats {
  installsAllTime?: number;
  downloads?: number;
  installsCurrent?: number;
  stars?: number;
}

export interface ClawHubSkillSummary {
  slug: string;
  ownerHandle?: string | null;
  sourceUrl?: string | null;
  displayName: string;
  summary: string;
  version?: string | null;
  /** The latest published version string, when known. */
  latestVersion?: string | null;
  updatedAt?: number | null;
  stats?: ClawHubStats | null;
}

export interface ClawHubScanResult {
  security?: {
    status?: string;
    hasWarnings?: boolean;
  };
}
