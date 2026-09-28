export interface HermesRuntimeInfo {
  available: boolean;
  version: string | null;
  revision: string | null;
  installation: 'source' | 'docker' | 'managed' | 'unknown';
  sourcePath: string | null;
  pythonPath: string | null;
  dirty: boolean | null;
}

export interface HermesCompatibility {
  schemaVersion: 1;
  version: string;
  revision: string;
  image: string;
  releaseUrl: string;
}

export type HermesUpdatePhase = 'idle' | 'preparing' | 'draining' | 'backing_up' | 'installing' | 'verifying' | 'completed' | 'failed' | 'rolled_back' | 'interrupted';

export interface HermesUpdateOperation {
  id: string;
  phase: HermesUpdatePhase;
  targetRevision: string;
  targetVersion: string;
  startedAt: number;
  updatedAt: number;
  message: string;
}

export interface HermesUpdateStatus {
  current: HermesRuntimeInfo;
  target: HermesCompatibility | null;
  olympusVersion: string;
  targetOlympusVersion: string | null;
  method: 'native' | 'docker' | 'dokploy' | 'unavailable';
  updateAvailable: boolean;
  canApply: boolean;
  reason: string | null;
  operation: HermesUpdateOperation | null;
  checkedAt: number;
  error?: string;
}
