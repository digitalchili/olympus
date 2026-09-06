type DrainStatus = { draining: boolean; activeRuns: number | null; ready: boolean };

interface ScheduledWork {
  setDraining(draining: boolean): void;
  activeRuns(): Promise<number>;
}

export class DrainController {
  private draining = false;
  private listeners = new Set<() => void>();
  private scheduledRuns: number | null = null;
  private generation = 0;

  constructor(private readonly activeRunCount: () => number, private readonly scheduledWork?: ScheduledWork) {}

  begin(): boolean {
    if (this.draining) return false;
    this.draining = true;
    this.generation += 1;
    this.scheduledRuns = null;
    this.scheduledWork?.setDraining(true);
    this.notifyRunChange();
    return true;
  }

  cancel(): boolean {
    if (!this.draining) return false;
    this.draining = false;
    this.generation += 1;
    this.scheduledRuns = null;
    this.scheduledWork?.setDraining(false);
    this.notifyRunChange();
    return true;
  }

  status(): DrainStatus {
    return {
      draining: this.draining,
      activeRuns: this.scheduledWork && this.scheduledRuns === null
        ? null : this.activeRunCount() + (this.scheduledRuns ?? 0),
      ready: !this.draining,
    };
  }

  async refreshStatus(): Promise<DrainStatus> {
    const generation = this.generation;
    if (this.scheduledWork) {
      let count: number | null = null;
      try {
        const result = await this.scheduledWork.activeRuns();
        if (Number.isSafeInteger(result) && result >= 0) count = result;
      } catch {
        // An unavailable/starting worker must not permit a maintenance handoff.
      }
      if (generation === this.generation) this.scheduledRuns = count;
    }
    return this.status();
  }

  notifyRunChange(): void {
    for (const listener of this.listeners) listener();
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.scheduledWork && this.activeRunCount() === 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let checking = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        this.listeners.delete(check);
        resolve(idle);
      };
      const check = async () => {
        if (checking || settled) return;
        checking = true;
        await this.refreshStatus();
        checking = false;
        if (this.status().activeRuns === 0) finish(true);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(check, Math.min(100, timeoutMs));
      this.listeners.add(check);
      void check();
    });
  }
}
