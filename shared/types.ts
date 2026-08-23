export const TASK_STATUSES = ['in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface QueuedTaskMessage {
  id: string;
  taskId: string;
  content: string;
  settings: {
    model?: string | null;
    provider?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    mode?: ChatRunMode;
  };
  invitedProfileIds: string[];
  collaborationScope: CollaborationInvitationScope;
  confirmPersistentCollaboration: boolean;
  createdAt: number;
  updatedAt: number;
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AppVersion {
  name: string;
  version: string;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateConfigured: boolean;
  releaseUrl: string | null;
  checkedAt: number;
  pendingUpdate?: {
    latestVersion: string;
    requestedAt: number;
  } | null;
  error?: string;
}

export interface UpdateApplyResult {
  accepted: true;
  queued: boolean;
}

export interface StudioGitHubInstallation {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  label: string;
  permissionMode: 'read_write' | 'upgrade_required';
  createdAt: number;
  updatedAt: number;
}

export interface StudioGitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
}

export interface StudioProject {
  id: string;
  name: string;
  provider: 'github';
  providerRepositoryId: number;
  installationId: number;
  owner: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  mode: 'read_only' | 'branch_pr';
  createdAt: number;
  updatedAt: number;
}

export const PROJECT_ACCESS_ROLES = ['view', 'contribute', 'manage'] as const;
export type ProjectAccessRole = (typeof PROJECT_ACCESS_ROLES)[number];

export interface ProjectProfileGrant {
  projectId: string;
  profileId: string;
  role: ProjectAccessRole;
  grantedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  purpose: string;
  managerProfileId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectManagerProjection {
  id: string;
  displayName: string;
  provider: string | null;
  model: string | null;
}

export interface ProjectSummary extends Project {
  manager: ProjectManagerProjection;
  repositoryLink?: ProjectRepositoryLink | null;
}

export interface ProjectManagerHistoryEntry {
  id: string;
  projectId: string;
  profileId: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  changedBy: string;
}

export interface ProjectRepositoryLink {
  projectId: string;
  provider: 'github';
  providerRepositoryId: number;
  installationId: number;
  owner: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  mode: 'read_only' | 'branch_pr';
  createdAt: number;
  updatedAt: number;
}

export interface ProjectReference {
  id: string;
  projectId: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  status: 'uploaded' | 'extracting' | 'indexed' | 'failed' | 'deleted';
  error: string | null;
  createdAt: number;
  updatedAt: number;
  indexedAt: number | null;
  deletedAt: number | null;
}

export type ProjectReferenceListItem = Omit<ProjectReference, 'storagePath'>;

export interface ProjectReferenceChunk {
  id: string;
  projectId: string;
  referenceId: string;
  versionId: string;
  chunkIndex: number;
  text: string;
  pageNumber: number | null;
  sheetName: string | null;
  cellRange: string | null;
  createdAt: number;
}

export interface ProjectReferenceCitation {
  referenceId: string;
  originalFilename: string;
  chunkIndex: number;
  pageNumber: number | null;
  sheetName: string | null;
  cellRange: string | null;
}

export interface ProjectReferenceSearchResult {
  chunkId: string;
  referenceId: string;
  snippet: string;
  citation: ProjectReferenceCitation;
}

export const PROJECT_REFERENCE_ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx', '.png', '.jpg', '.jpeg'] as const;

export const CHAT_RUN_MODES = ['task', 'goal'] as const;
export type ChatRunMode = (typeof CHAT_RUN_MODES)[number];
export const OLYMPUS_GOAL_MAX_TURNS = 20;

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
  displayName: string;
  label: string;
  description: string;
  active: boolean;
  isDefault: boolean;
  capabilities: HermesProfileCapabilities;
  health: HermesProfileHealth;
}

export interface ProfileTaskAttention {
  profileId: string;
  reviewCount: number;
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

export type HermesChannelHealth = 'healthy' | 'degraded' | 'inactive' | 'unknown';

export const HERMES_INFRASTRUCTURE_CHANNEL_IDS = [
  'api',
  'api-server',
  'api_server',
  'webhook',
] as const;

export function isHermesMessageChannelId(id: string): boolean {
  return !(HERMES_INFRASTRUCTURE_CHANNEL_IDS as readonly string[]).includes(id);
}

/** Secret-free projection of one messaging platform owned by Hermes. */
export interface HermesChannel {
  id: string;
  displayLabel: string;
  enabled: boolean;
  health: HermesChannelHealth;
}

export type HermesChannelHistoryState = 'available' | 'awaiting_bridge';

/** Secret-free, profile-scoped projection of one Hermes gateway conversation. */
export interface HermesChannelThread {
  id: string;
  channelId: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface HermesChannelMessage {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  contentTruncated: boolean;
  createdAt: number;
}

export interface HermesChannelThreadsResult {
  state: HermesChannelHistoryState;
  threads: HermesChannelThread[];
}

export interface HermesChannelMessagesResult {
  state: HermesChannelHistoryState;
  messages: HermesChannelMessage[];
  truncated: boolean;
}

export interface HermesProfileCreateInput extends Omit<HermesProfileSettings, 'id'> {
  id: string;
  active?: boolean;
}

export interface ProfileBuilderSuggestion {
  displayName: string;
  description: string;
  soul: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: ReasoningEffort | null;
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
  project_id: string | null;
  handling_profile_id: string | null;
  delegated_worker_id: string | null;
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

export type ProjectEditorLeaseStatus = 'active' | 'released';
export type ProjectVersionAction = 'commit_push' | 'revert';

export interface ProjectEditorLease {
  id: string;
  projectId: string;
  taskId: string;
  profileId: string;
  repositoryFullName: string;
  baseBranch: string;
  branchName: string;
  workdir: string;
  baseSha: string | null;
  status: ProjectEditorLeaseStatus;
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
}

export type PublicProjectEditorLease = Omit<ProjectEditorLease, 'workdir'>;

export interface ProjectVersion {
  id: string;
  projectId: string;
  taskId: string | null;
  leaseId: string | null;
  action: ProjectVersionAction;
  commitSha: string;
  parentSha: string | null;
  revertedVersionId: string | null;
  branchName: string;
  commitMessage: string;
  changedFiles: string[];
  pushedAt: number;
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
  attachments?: TaskAttachment[];
}

export interface TaskMessagePageInfo {
  hasOlder: boolean;
  olderCursor: string | null;
}

export const TASK_MESSAGE_PAGE_SIZE = 40;
export const TASK_MESSAGE_PAGE_MAX_SIZE = 100;

export interface TaskMessagesPage {
  messages: TaskMessage[];
  pageInfo: TaskMessagePageInfo;
  context?: ContextUsage | null;
}

export interface TaskAttachment {
  path: string;
  name: string;
  size: number;
}

export const COLLABORATION_RUN_STATUSES = [
  'gathering',
  'proposal',
  'review',
  'synthesizing',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const;
export type CollaborationRunStatus = (typeof COLLABORATION_RUN_STATUSES)[number];

export type CollaborationContributionPhase = 'proposal' | 'review';
export type CollaborationContributionStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';

export type CollaborationInvitationScope = 'discussion' | 'task' | 'project';

export interface PersistentCollaborationGrant {
  scope: Exclude<CollaborationInvitationScope, 'discussion'>;
  scopeId: string;
  profileId: string;
  grantedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CollaborationContribution {
  id: string;
  run_id: string;
  profile_id: string;
  profile_label: string;
  session_id: string;
  phase: CollaborationContributionPhase;
  phase_round: 1 | 2;
  status: CollaborationContributionStatus;
  content: string | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface CollaborationRun {
  id: string;
  task_id: string;
  round: number;
  status: CollaborationRunStatus;
  question: string;
  owner_profile_id: string;
  owner_invited: boolean;
  created_at: number;
  contributors_completed_at: number | null;
  completed_at: number | null;
  contributions: CollaborationContribution[];
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

export type DelegationRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown';

/** A deliberately narrow, visibility-only projection of one delegated worker. */
export interface DelegationRun {
  id: string;
  profile_name: string;
  task_id: string;
  parent_session_id: string;
  delegation_id: string;
  child_id: string;
  child_session_id: string | null;
  parent_child_id: string | null;
  child_index: number;
  child_count: number;
  status: DelegationRunStatus;
  current_action: string | null;
  model: string | null;
  tool_count: number;
  api_calls: number;
  duration_seconds: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  files_touched: number;
  created_at: number;
  started_at: number | null;
  last_activity_at: number;
  completed_at: number | null;
  updated_at: number;
}

export interface DelegationWorkerEvent {
  schema: 'olympus.delegation.event.v1';
  delegationId: string;
  childId: string;
  parentSessionId: string;
  childSessionId: string | null;
  parentChildId: string | null;
  childIndex: number;
  childCount: number;
  status: DelegationRunStatus;
  currentAction: string | null;
  model: string | null;
  toolCount: number;
  apiCalls: number;
  durationSeconds: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  filesTouched: number;
}

export interface AdapterDelegationEvent {
  profileId?: string;
  taskId: string;
  event: DelegationWorkerEvent;
}

export type BoardEvent =
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'task_runs_snapshot'; runs: TaskRunState[] }
  | { type: 'task_run_updated'; run: TaskRunState }
  | { type: 'delegations_snapshot'; runs: DelegationRun[] }
  | { type: 'delegation_run_updated'; run: DelegationRun }
  | { type: 'maintenance_reconnect' };

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
  /** Present when this item comes from the reviewed Digital Chili registry. */
  curated?: CuratedSkillSummary;
}

export interface ClawHubScanResult {
  security?: {
    status?: string;
    hasWarnings?: boolean;
  };
}

/** A reviewed skill from Digital Chili's pinned, private registry. */
export interface CuratedSkillSummary {
  id: string;
  displayName: string;
  summary: string;
  status: 'approved' | 'experimental' | 'deprecated';
  owner: string;
  tags: string[];
  version: string;
  sourceUrl: string;
  provenance: {
    type: string;
    source: string;
    revision?: string;
    license: string;
  };
}
