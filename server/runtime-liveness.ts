export type RuntimeLivenessStatus = {
  failures: number;
  retryAfter: number | null;
};

export function createRuntimeLiveness(options: {
  checkWorker: () => Promise<boolean>;
  now?: () => number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  onFailure?: (status: RuntimeLivenessStatus) => void;
}) {
  const now = options.now ?? Date.now;
  const baseCooldownMs = options.baseCooldownMs ?? 15_000;
  const maxCooldownMs = options.maxCooldownMs ?? 120_000;
  let failures = 0;
  let retryAfter: number | null = null;

  const status = (): RuntimeLivenessStatus => ({ failures, retryAfter });

  return {
    status,
    async probe(): Promise<{ ready: boolean; checked: boolean }> {
      const current = now();
      if (retryAfter !== null && current < retryAfter) return { ready: false, checked: false };

      const healthy = await options.checkWorker().catch(() => false);
      if (healthy) {
        failures = 0;
        retryAfter = null;
        return { ready: true, checked: true };
      }

      failures += 1;
      retryAfter = current + Math.min(baseCooldownMs * (2 ** (failures - 1)), maxCooldownMs);
      options.onFailure?.(status());
      return { ready: false, checked: true };
    },
  };
}
