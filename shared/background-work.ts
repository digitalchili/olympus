export interface TaskBackgroundWork {
  available: boolean;
  continuation?: { status: 'pending' | 'blocked' | 'none'; reason?: string };
  work: Array<{ id: string; kind: 'process' | 'delegation' | 'operation'; status: string }>;
  errorCode?: string;
}

export interface TaskBackgroundWorkStatus extends TaskBackgroundWork {
  runId: string | null;
  canStop: boolean;
}
