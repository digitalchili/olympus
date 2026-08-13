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
  TaskMessagesPage,
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
  HermesChannel,
  HermesChannelMessagesResult,
  HermesChannelThreadsResult,
  HermesProfile,
  HermesProfileCreateInput,
  HermesProfileSettings,
  HermesProfileSettingsUpdate,
  ProfileBuilderSuggestion,
  PersistentCollaborationGrant,
  ProjectAccessRole,
  ProjectManagerHistoryEntry,
  ProjectProfileGrant,
  ProjectReferenceChunk,
  ProjectReferenceListItem,
  ProjectReferenceSearchResult,
  ProjectSummary,
  ProjectRepositoryLink,
  StudioGitHubInstallation,
  StudioGitHubRepository,
  StudioProject,
  UpdateStatus,
} from '@shared/types';
import { TASK_MESSAGE_PAGE_SIZE } from '@shared/types';
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

async function request<T>(path: string, init?: RequestInit, profileScoped = true): Promise<T> {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const isFormDataBody = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const res = await fetch(`${BASE}${profileScoped ? apiPathWithProfile(path) : path}`, {
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

export function moveTask(id: string, status: TaskStatus, profileId?: string | null) {
  const path = profileId ? apiPathWithProfile(`/tasks/${id}/move`, profileId) : `/tasks/${id}/move`;
  return request<{ task: Task }>(path, {
    method: 'POST',
    body: JSON.stringify({ status }),
  }, !profileId);
}

export function deleteTask(id: string, profileId?: string | null) {
  const path = profileId ? apiPathWithProfile(`/tasks/${id}`, profileId) : `/tasks/${id}`;
  return request<{ ok: boolean }>(path, { method: 'DELETE' }, !profileId);
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
  options?: {
    projectId?: string | null;
    handlingProfileId?: string | null;
    routingProfileId?: string | null;
  },
) {
  const routingProfileId = options?.routingProfileId ?? options?.handlingProfileId;
  const path = routingProfileId
    ? apiPathWithProfile('/tasks', routingProfileId)
    : '/tasks';
  return request<{ task: Task }>(path, {
    method: 'POST',
    body: JSON.stringify({
      description,
      title,
      workdir,
      projectId: options?.projectId ?? null,
      handlingProfileId: options?.handlingProfileId ?? null,
    }),
  }, !routingProfileId);
}

export interface TaskSearchResult {
  taskId: string;
  handlingProfileId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  role: 'task' | 'user' | 'assistant' | 'system' | 'tool';
  snippet: string;
  timestamp: number;
}

export function searchTasks(query: string, projectId?: string) {
  const params = new URLSearchParams({ q: query });
  if (projectId) params.set('projectId', projectId);
  return request<{ results: TaskSearchResult[] }>(`/search?${params.toString()}`);
}

export function fetchMessages(taskId: string, before?: string | null) {
  const params = new URLSearchParams({ limit: String(TASK_MESSAGE_PAGE_SIZE) });
  if (before) params.set('before', before);
  return request<TaskMessagesPage>(`/tasks/${encodeURIComponent(taskId)}/messages?${params}`);
}

export function fetchCollaborations(taskId: string) {
  return request<{ runs: CollaborationRun[] }>(`/tasks/${taskId}/collaborations`);
}

export function fetchCollaborationGrants(taskId: string) {
  return request<{ grants: PersistentCollaborationGrant[] }>(`/tasks/${encodeURIComponent(taskId)}/collaboration-grants`);
}

export function revokeCollaborationGrant(
  taskId: string,
  scope: PersistentCollaborationGrant['scope'],
  profileId: string,
) {
  return request<{ revoked: boolean }>(
    `/tasks/${encodeURIComponent(taskId)}/collaboration-grants/${scope}/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' },
  );
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

export function fetchUpdateStatus(refresh = false) {
  return request<UpdateStatus>(refresh ? '/updates?refresh=true' : '/updates', undefined, false);
}

export function applyUpdate() {
  return request<{ accepted: true }>('/updates/apply', { method: 'POST' }, false);
}

export function fetchStudioGitHubStatus() {
  return request<{ configured: boolean; installations: StudioGitHubInstallation[] }>('/studio/github/status', undefined, false);
}

export function connectStudioGitHub(owner: string | null) {
  return request<{
    url: string;
    method: 'GET' | 'POST';
    fields: Record<string, string>;
  }>('/studio/github/connect', {
    method: 'POST',
    body: JSON.stringify({ owner }),
  }, false);
}

export function fetchStudioRepositories(installationId: number) {
  return request<{ repositories: StudioGitHubRepository[] }>(
    `/studio/github/repositories?installationId=${encodeURIComponent(installationId)}`,
    undefined,
    false,
  );
}

export function fetchStudioProjects() {
  return request<{ projects: StudioProject[] }>('/studio/projects', undefined, false);
}

export function importStudioProject(installationId: number, repositoryId: number) {
  return request<{ project: StudioProject }>('/studio/projects', {
    method: 'POST',
    body: JSON.stringify({ installationId, repositoryId }),
  }, false);
}

export function fetchProjects() {
  return request<{ projects: ProjectSummary[] }>('/projects', undefined, false);
}

export function createProject(input: { name: string; purpose: string; managerProfileId: string; repositoryLink?: { installationId: number; repositoryId: number } | null }) {
  return request<{ project: ProjectSummary }>('/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  }, false);
}

export function fetchProject(projectId: string) {
  return request<{ project: ProjectSummary; managerHistory: ProjectManagerHistoryEntry[] }>(
    `/projects/${encodeURIComponent(projectId)}`,
    undefined,
    false,
  );
}

export function updateProject(projectId: string, input: { name?: string; purpose?: string; repositoryLink?: { installationId: number; repositoryId: number } | null }) {
  return request<{ project: ProjectSummary }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, false);
}


export function fetchProjectRepositoryLink(projectId: string) {
  return request<{ repositoryLink: ProjectRepositoryLink | null }>(
    `/projects/${encodeURIComponent(projectId)}/repository`,
    undefined,
    false,
  );
}

export function upsertProjectRepositoryLink(projectId: string, installationId: number, repositoryId: number) {
  return request<{ repositoryLink: ProjectRepositoryLink }>(
    `/projects/${encodeURIComponent(projectId)}/repository`,
    { method: 'PUT', body: JSON.stringify({ installationId, repositoryId }) },
    false,
  );
}

export function deleteProjectRepositoryLink(projectId: string) {
  return request<void>(
    `/projects/${encodeURIComponent(projectId)}/repository`,
    { method: 'DELETE' },
    false,
  );
}

export function fetchProjectGrants(projectId: string) {
  return request<{ grants: ProjectProfileGrant[] }>(
    `/projects/${encodeURIComponent(projectId)}/grants`,
    undefined,
    false,
  );
}

export function setProjectGrant(projectId: string, profileId: string, role: ProjectAccessRole) {
  return request<{ grant: ProjectProfileGrant }>(
    `/projects/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(profileId)}`,
    { method: 'PUT', body: JSON.stringify({ role }) },
    false,
  );
}

export function revokeProjectGrant(projectId: string, profileId: string) {
  return request<void>(
    `/projects/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' },
    false,
  );
}

export function fetchProjectTasks(projectId: string) {
  return request<{ tasks: Task[] }>(
    `/projects/${encodeURIComponent(projectId)}/tasks`,
    undefined,
    false,
  );
}

export function reassignProjectManager(
  projectId: string,
  managerProfileId: string,
  previousManagerRole: 'view' | 'contribute' | null,
) {
  return request<{ project: ProjectSummary }>(`/projects/${encodeURIComponent(projectId)}/reassign`, {
    method: 'POST',
    body: JSON.stringify({ managerProfileId, previousManagerRole }),
  }, false);
}

export function fetchProjectReferences(projectId: string) {
  return request<{ references: ProjectReferenceListItem[] }>(
    `/projects/${encodeURIComponent(projectId)}/references`,
    undefined,
    false,
  );
}

export function uploadProjectReference(projectId: string, file: File, signal?: AbortSignal) {
  const formData = new FormData();
  formData.append('file', file, file.name);
  return request<{ reference: ProjectReferenceListItem }>(
    `/projects/${encodeURIComponent(projectId)}/references`,
    { method: 'POST', body: formData, signal },
    false,
  );
}

export function fetchProjectReference(projectId: string, referenceId: string) {
  return request<{ reference: ProjectReferenceListItem; chunks: ProjectReferenceChunk[] }>(
    `/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}`,
    undefined,
    false,
  );
}

export function searchProjectReferences(projectId: string, q: string) {
  return request<{ results: ProjectReferenceSearchResult[] }>(
    `/projects/${encodeURIComponent(projectId)}/references/search?q=${encodeURIComponent(q)}`,
    undefined,
    false,
  );
}

export function reindexProjectReference(projectId: string, referenceId: string) {
  return request<{ reference: ProjectReferenceListItem }>(
    `/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}/reindex`,
    { method: 'POST' },
    false,
  );
}

export function deleteProjectReference(projectId: string, referenceId: string) {
  return request<void>(
    `/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}`,
    { method: 'DELETE' },
    false,
  );
}

export function projectReferenceDownloadUrl(projectId: string, referenceId: string) {
  return `${BASE}/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}/download`;
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

export function fetchHermesChannels(profileId?: string) {
  const path = profileId ? apiPathWithProfile('/channels', profileId) : '/channels';
  return request<{ channels: HermesChannel[] }>(path);
}

export function fetchChannelThreads(channelId: string, profileId: string) {
  const path = `/channels/${encodeURIComponent(channelId)}/threads`;
  return request<HermesChannelThreadsResult>(apiPathWithProfile(path, profileId));
}

export function fetchChannelMessages(channelId: string, threadId: string, profileId: string) {
  const path = `/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/messages`;
  return request<HermesChannelMessagesResult>(apiPathWithProfile(path, profileId));
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

export function installSkill(input: { provider?: 'clawhub' | 'digital-chili'; slug: string; ownerHandle?: string | null; version?: string; force?: boolean }, profileId?: string) {
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

/** Omitting the path lets the server answer with its own workspace root, which is the
 *  only side that knows where OLYMPUS_DISPATCH_HOME actually points. */
export function listFiles(path?: string) {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
  return request<FileListResponse>(`/files/list${query}`);
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
