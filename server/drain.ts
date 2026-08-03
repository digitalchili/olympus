type DrainStatus = { draining: boolean; activeRuns: number; ready: boolean };

export class DrainController {
  private draining = false;
  private listeners = new Set<() => void>();

  constructor(private readonly activeRunCount: () => number) {}

  begin(): boolean {
    if (this.draining) return false;
    this.draining = true;
    this.notifyRunChange();
    return true;
  }

  cancel(): boolean {
    if (!this.draining) return false;
    this.draining = false;
    this.notifyRunChange();
    return true;
  }

  status(): DrainStatus {
    return {
      draining: this.draining,
      activeRuns: this.activeRunCount(),
      ready: !this.draining,
    };
  }

  notifyRunChange(): void {
    for (const listener of this.listeners) listener();
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.activeRunCount() === 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      const finish = (idle: boolean) => {
        clearTimeout(timeout);
        clearInterval(poll);
        this.listeners.delete(check);
        resolve(idle);
      };
      const check = () => {
        if (this.activeRunCount() === 0) finish(true);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(check, Math.min(100, timeoutMs));
      this.listeners.add(check);
    });
  }
}
