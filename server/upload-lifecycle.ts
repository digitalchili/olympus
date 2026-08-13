import { rm } from 'node:fs/promises';

export type UploadOutcome = 'success' | 'failed' | 'aborted' | 'timeout';

export function createUploadLifecycle(options: {
  requestId: string;
  requestDir: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(options.requestDir, { recursive: true, force: true });
  };

  return {
    cleanup,
    abort: async (_reason: string) => cleanup(),
    logFields: (outcome: UploadOutcome, reason?: string, size?: number) => ({
      event: 'upload',
      requestId: options.requestId,
      outcome,
      ...(reason ? { reason } : {}),
      ...(size === undefined ? {} : { size }),
      elapsedMs: Math.max(0, now() - startedAt),
    }),
  };
}
