export interface SourceSnapshot {
  head: string; fingerprint: string; changedFiles: string[]; diff: string;
}
export interface CodingCheck {
  command: string[]; exitCode: number | null; output: string; durationMs: number; timedOut: boolean;
}
export interface RunningCodingCheck {
  command: string[]; output: string; startedAt: number; durationMs: number;
}
export interface CodingEvidence {
  taskId: string; runId: string; workdir: string; status: 'pending' | 'running' | 'passed' | 'failed' | 'stale' | 'unconfigured' | 'skipped';
  baseline: SourceSnapshot; source: SourceSnapshot | null; checks: CodingCheck[];
  currentCheck?: RunningCodingCheck | null;
  reason: string | null; updatedAt: number;
}
