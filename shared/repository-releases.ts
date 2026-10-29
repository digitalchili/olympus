import type { CodingCheck } from './coding-evidence.js';

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
  release?: RepositoryRelease | null;
}

export type RepositoryReleaseMode = 'all' | 'ready';
export interface RepositoryRelease {
  id: string; mode: RepositoryReleaseMode;
  state: 'waiting' | 'checking' | 'publishing' | 'blocked' | 'confirmed' | 'cancelled';
  included: RepositoryChange[]; excluded: RepositoryChange[];
  message: string; targetBranch: string; commitSha: string | null; createdAt: number;
  checks?: CodingCheck[];
}
export interface RepositoryReleasePreview {
  token: string; mode: RepositoryReleaseMode; included: RepositoryChange[]; excluded: RepositoryChange[]; targetBranch: string;
  targetSha: string;
}
