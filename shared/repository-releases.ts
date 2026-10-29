export interface RepositoryChange {
  id: string;
  taskId: string;
  title: string;
  projectId: string;
  profileId: string;
  state: 'ready' | 'working' | 'needs_attention' | 'stopped';
  reason: string;
  changedFiles: string[];
  commitSha: string | null;
  previousSha: string | null;
  runId: string | null;
  queueId: string | null;
}
export interface RepositoryOverview {
  repositoryKey: string;
  repositoryName: string;
  targetBranch: string;
  targetSha: string | null;
  acceptedSha: string | null;
  hasHiddenWork: boolean;
  changes: RepositoryChange[];
}
