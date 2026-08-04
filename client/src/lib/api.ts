import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentRunSettings,
  AppVersion,
  CompactResult,
  FileCreateResponse,
  FileCreateType,
  FileDeleteResponse,
  FileListResponse,
  FileReadResponse,
  FileRenameResponse,
  FileUploadResponse,
  FileWriteResponse,
  ContextUsage,
  SessionMetadata,
  Task,
  TaskAgentSettings,
  TaskMessage,
  TaskStatus,
  ReasoningEffort,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunContent,
  SkillMeta,
  SkillInstallResult,
  ClawHubSkillSummary,
  ClawHubScanResult,
  CollaborationRun,
  HermesProfile,
  HermesProfileCreateInput,
  HermesProfileSettings,
  HermesProfileSettingsUpdate,
  ProfileBuilderSuggestion,
} from '@shared/types';
import { apiPathWithProfile } from './profileQuery';

export type { HermesProfile, SkillMeta, SkillInstallResult };

export type { AgentRunSettings };

export const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const isFormDataBody = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const res = await fetch(`${BASE}${apiPathWithProfile(path)}`, {
    headers: isFormDataBody
      ? extraHeaders
      : { 'Content-Type': 'application/json', ...extraHeaders as Record<string, string> },
    ...rest,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
    throw new ApiError(message, res.status, code);
  }
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fetchTasks() {
  return request<{ tasks: Task[] }>('/tasks');
}

export function moveTask(id: string, status: TaskStatus) {
  return request<{ task: Task }>(`/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export function deleteTask(id: string) {
  return request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' });
}

export function patchTask(id: string, fields: { title?: string; description?: string; status?: TaskStatus; workdir?: string | null }) {
  return request<{ task: Task }>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function markTaskViewed(id: string) {
  return request<{ task: Task }>(`/tasks/${id}/viewed`, {
    method: 'POST',
  });
}

export function createTask(
  description: string,
  title?: string,
  workdir?: string | null,
  requestedProfileName?: string | null,
) {
  const path = requestedProfileName
    ? apiPathWithProfile('/tasks', requestedProfileName)
    : '/tasks';
  return request<{ task: Task }>(path, {
    method: 'POST',
    body: JSON.stringify({ description, title, workdir, requestedProfileName }),
  });
}

export interface TaskSearchResult {
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  role: 'task' | 'user' | 'assistant' | 'system' | 'tool';
  snippet: string;
  timestamp: number;
}

export function searchTasks(query: string) {
  return request<{ results: TaskSearchResult[] }>(`/search?q=${encodeURIComponent(query)}`);
}

export function fetchMessages(taskId: string) {
  return request<{ messages: TaskMessage[]; context?: ContextUsage | null }>(`/tasks/${taskId}/messages`);
}

export function fetchCollaborations(taskId: string) {
  return request<{ runs: CollaborationRun[] }>(`/tasks/${taskId}/collaborations`);
}

export function fetchSession(taskId: string) {
  return request<{ session: SessionMetadata | null }>(`/tasks/${taskId}/session`);
}

export function fetchHealth() {
  return request<{ ok: boolean; hermes: boolean }>('/health');
}

export function fetchAppVersion() {
  return request<AppVersion>('/version');
}

export interface InstallationSettings {
  name: string;
}

export function fetchInstallationSettings() {
  return request<InstallationSettings>('/installation');
}

export function updateInstallationName(name: string) {
  return request<InstallationSettings>('/installation', {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function fetchHermesProfiles(includeInactive = false) {
  return request<{ profiles: HermesProfile[] }>(includeInactive ? '/profiles?includeInactive=true' : '/profiles');
}

export function createHermesProfile(input: HermesProfileCreateInput) {
  return request<{ profile: HermesProfile }>('/profiles', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function draftHermesProfile(description: string) {
  return request<{ suggestion: ProfileBuilderSuggestion }>('/profiles/draft', {
    method: 'POST',
    body: JSON.stringify({ description }),
  });
}

export function fetchProfileSettings(profileId: string) {
  return request<{ settings: HermesProfileSettings }>(`/profiles/${encodeURIComponent(profileId)}/settings`);
}

export function updateProfileSettings(profileId: string, updates: HermesProfileSettingsUpdate) {
  return request<{ settings: HermesProfileSettings }>(`/profiles/${encodeURIComponent(profileId)}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function deactivateHermesProfile(profileId: string) {
  return request<{ profile: HermesProfile }>(`/profiles/${encodeURIComponent(profileId)}/deactivate`, { method: 'POST' });
}

export function reactivateHermesProfile(profileId: string) {
  return request<{ profile: HermesProfile }>(`/profiles/${encodeURIComponent(profileId)}/reactivate`, { method: 'POST' });
}

export function deleteHermesProfile(profileId: string, confirmation: string) {
  return request<{ ok: true; backupDir: string; deletedTaskCount: number }>(`/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  });
}

export function fetchAgentDefaults() {
  return request<AgentDefaults>('/agent/defaults');
}

export function fetchAgentModels(profileId?: string) {
  const path = profileId ? apiPathWithProfile('/agent/models', profileId) : '/agent/models';
  return request<AgentModelsResponse>(path);
}

export function updateAgentDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) {
  return request<AgentDefaults>('/agent/defaults', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchTaskAgentSettings(taskId: string) {
  return request<TaskAgentSettings>(`/tasks/${taskId}/agent-settings`);
}

export function compactTask(taskId: string, focusTopic?: string | null) {
  return request<CompactResult>(`/tasks/${taskId}/compact`, {
    method: 'POST',
    body: JSON.stringify(focusTopic ? { focusTopic } : {}),
  });
}

export function interruptTask(taskId: string, reason?: string) {
  return request<{ interrupted: boolean }>(`/tasks/${taskId}/interrupt`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function steerTask(taskId: string, content: string) {
  return request<{ steered: boolean; queued: boolean }>(`/tasks/${taskId}/steer`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function fetchScheduledTasks(includeDisabled = true, limit = 100) {
  return request<{ scheduledTasks: ScheduledTask[] }>(`/scheduled-tasks?includeDisabled=${includeDisabled ? 'true' : 'false'}&limit=${limit}`);
}

export function fetchScheduledTask(scheduledTaskId: string) {
  return request<{ scheduledTask: ScheduledTask | null }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}`);
}

export function createScheduledTask(input: ScheduledTaskInput) {
  return request<{ scheduledTask: ScheduledTask }>('/scheduled-tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchSkills(profileId?: string) {
  const path = profileId ? apiPathWithProfile('/skills', profileId) : '/skills';
  return request<{ skills: SkillMeta[] }>(path);
}

export function fetchSkillContent(id: string, profileId?: string) {
  const path = `/skills/${encodeURIComponent(id)}/content`;
  return request<{ skill: SkillMeta; content: string }>(profileId ? apiPathWithProfile(path, profileId) : path);
}

export function deleteSkill(id: string, profileId?: string) {
  const path = `/skills/${encodeURIComponent(id)}`;
  return request<{ ok: boolean; skill: SkillMeta }>(profileId ? apiPathWithProfile(path, profileId) : path, {
    method: 'DELETE',
  });
}

export function installSkill(input: { provider?: 'clawhub'; slug: string; ownerHandle?: string | null; version?: string; force?: boolean }, profileId?: string) {
  const path = profileId ? apiPathWithProfile('/skills/install', profileId) : '/skills/install';
  return request<SkillInstallResult>(path, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function importSkillFiles(
  files: File[],
  relativePathFor: (file: File) => string = fileRelativePath,
  profileId?: string,
  signal?: AbortSignal,
) {
  const formData = new FormData();

  for (const file of files) {
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePathFor(file));
  }

  const path = profileId ? apiPathWithProfile('/skills/import', profileId) : '/skills/import';
  return request<SkillInstallResult>(path, {
    method: 'POST',
    body: formData,
    signal,
  });
}

export function searchClawHubSkills(query: string, limit = 24): Promise<ClawHubSkillSummary[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request<{ skills: ClawHubSkillSummary[] }>(`/skills/registry/search?${params}`).then((res) => res.skills);
}

export function browseClawHubSkills(limit = 24): Promise<ClawHubSkillSummary[]> {
  return request<{ skills: ClawHubSkillSummary[] }>(`/skills/registry/browse?limit=${limit}`).then((res) => res.skills);
}

export function fetchClawHubSkillContent(slug: string, version?: string | null, ownerHandle?: string | null): Promise<string> {
  const params = new URLSearchParams();
  if (version) params.set('version', version);
  if (ownerHandle) params.set('ownerHandle', ownerHandle);
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  return request<{ content: string }>(`/skills/registry/${encodeURIComponent(slug)}/content${suffix}`).then((res) => res.content);
}

export function fetchClawHubSkillScan(slug: string, version?: string | null, ownerHandle?: string | null): Promise<ClawHubScanResult> {
  const params = new URLSearchParams();
  if (version) params.set('version', version);
  if (ownerHandle) params.set('ownerHandle', ownerHandle);
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  return request<ClawHubScanResult>(`/skills/registry/${encodeURIComponent(slug)}/scan${suffix}`);
}

export const WORKSPACE_ROOT = '~/.olympus-dispatch/workspace';

export function listFiles(path = WORKSPACE_ROOT) {
  return request<FileListResponse>(`/files/list?path=${encodeURIComponent(path)}`);
}

export function readFile(path: string) {
  return request<FileReadResponse>(`/files/read?path=${encodeURIComponent(path)}`);
}

export function fileDownloadUrl(path: string) {
  return `${BASE}${apiPathWithProfile(`/files/download?path=${encodeURIComponent(path)}`)}`;
}

export function filePreviewUrl(path: string) {
  return `${BASE}${apiPathWithProfile(`/files/preview?path=${encodeURIComponent(path)}`)}`;
}

export function writeFile(path: string, content: string, expectedModifiedAt?: number, overwrite = false) {
  return request<FileWriteResponse>('/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content, expectedModifiedAt, overwrite }),
  });
}

export function createFileEntry(parentPath: string, name: string, type: FileCreateType, content?: string) {
  return request<FileCreateResponse>('/files/create', {
    method: 'POST',
    body: JSON.stringify({ parentPath, name, type, content }),
  });
}

export function renameFileEntry(path: string, newName: string) {
  return request<FileRenameResponse>('/files/rename', {
    method: 'PATCH',
    body: JSON.stringify({ path, newName }),
  });
}

export function uploadFileEntries(
  parentPath: string,
  files: File[],
  relativePathFor: (file: File) => string = fileRelativePath,
  signal?: AbortSignal,
) {
  const formData = new FormData();
  formData.append('targetPath', parentPath);

  for (const file of files) {
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePathFor(file));
  }

  return request<FileUploadResponse>('/files/upload', {
    method: 'POST',
    body: formData,
    signal,
  });
}

export function deleteFileEntry(path: string, recursive = false) {
  return request<FileDeleteResponse>('/files', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  });
}

export function updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchScheduledTaskRuns(scheduledTaskId: string, limit = 50) {
  return request<{ runs: ScheduledTaskRun[] }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/runs?limit=${limit}`);
}

export function fetchScheduledTaskRunContent(scheduledTaskId: string, runId: string) {
  return request<{ content: ScheduledTaskRunContent }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/runs/${encodeURIComponent(runId)}/content`);
}

export function pauseScheduledTask(scheduledTaskId: string, reason?: string) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function resumeScheduledTask(scheduledTaskId: string) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/resume`, {
    method: 'POST',
  });
}

export function runScheduledTask(scheduledTaskId: string) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/run`, {
    method: 'POST',
  });
}

export function deleteScheduledTask(scheduledTaskId: string) {
  return request<{ ok: boolean }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}`, {
    method: 'DELETE',
  });
}

export async function uploadChatAttachment(
  bucketId: string,
  fileId: string,
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  // fileId (a UUID) prefixes the name so same-named files don't collide and a
  // single attachment can be deleted by its own path.
  const relativePath = `uploads/${bucketId}/${fileId}-${file.name}`;
  await uploadFileEntries(WORKSPACE_ROOT, [file], () => relativePath, signal);
  return `${WORKSPACE_ROOT}/${relativePath}`;
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}
