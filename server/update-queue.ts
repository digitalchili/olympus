export interface PendingUpdateRequest {
  id: string;
  repository: string;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string | null;
  requestedAt: number;
}

export interface PendingUpdateStore {
  load(): PendingUpdateRequest | null;
  saveIfEmpty(request: PendingUpdateRequest): PendingUpdateRequest;
  remove(request: PendingUpdateRequest): void;
}

export type UpdateDispatchResult = 'none' | 'waiting' | 'busy' | 'accepted' | 'failed' | 'stale';

interface DurableUpdateCoordinatorOptions {
  store: PendingUpdateStore;
  activeRuns: () => number;
  currentVersion: () => string;
  dispatch: (request: PendingUpdateRequest) => Promise<number>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

function parseVersion(value: string): number[] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index++) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export class DurableUpdateCoordinator {
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private dispatching = false;

  constructor(private readonly options: DurableUpdateCoordinatorOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  pending(): PendingUpdateRequest | null {
    return this.options.store.load();
  }

  enqueue(request: PendingUpdateRequest): PendingUpdateRequest {
    const pending = this.options.store.saveIfEmpty(request);
    this.schedule(0);
    return pending;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async attemptDispatch(activeRunAllowance = 0): Promise<UpdateDispatchResult> {
    if (this.dispatching) return 'busy';
    const pending = this.options.store.load();
    if (!pending) return 'none';

    const currentVersion = this.options.currentVersion();
    if (parseVersion(currentVersion) && !isVersionNewer(pending.latestVersion, currentVersion)) {
      this.options.store.remove(pending);
      return 'stale';
    }
    if (this.options.activeRuns() > activeRunAllowance) return 'waiting';

    this.dispatching = true;
    try {
      const status = await this.options.dispatch(pending);
      if (status >= 200 && status < 300) {
        this.options.store.remove(pending);
        return 'accepted';
      }
      this.options.onError?.(new Error(`The deployment hook rejected the queued update (${status}).`));
      return 'failed';
    } catch (error) {
      this.options.onError?.(error);
      return 'failed';
    } finally {
      this.dispatching = false;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledAttempt();
    }, delayMs);
    this.timer.unref();
  }

  private async runScheduledAttempt(): Promise<void> {
    await this.attemptDispatch();
    if (this.started && this.options.store.load()) this.schedule(this.pollIntervalMs);
  }
}
