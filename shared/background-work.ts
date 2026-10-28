export interface TaskBackgroundWork {
  available: boolean;
  continuation?: { status: 'pending' | 'blocked' | 'none'; reason?: string };
  checkpoint?: { saved: boolean; source: string; pendingDelegationIds: string[]; undeliveredResultCount: number };
  work: Array<{ id: string; kind: 'process' | 'delegation' | 'operation'; status: string }>;
  errorCode?: string;
}

export interface TaskBackgroundWorkStatus extends TaskBackgroundWork {
  runId: string | null;
  canStop: boolean;
  canContinue?: boolean;
}

/** A finished assistant may reuse its own services; children/results may not overlap. */
export function onlyBackgroundProcesses(inventory: TaskBackgroundWork): boolean {
  return inventory.available && inventory.work.length > 0
    && inventory.work.every(item => item.kind === 'process')
    && (!inventory.continuation || inventory.continuation.status === 'none')
    && (!inventory.checkpoint || (inventory.checkpoint.pendingDelegationIds.length === 0
      && inventory.checkpoint.undeliveredResultCount === 0));
}
