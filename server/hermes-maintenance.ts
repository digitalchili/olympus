import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './adapters/types.js';
import type { DrainController } from './drain.js';
import { resolveOlympusHome } from './paths.js';

export function hermesUpdateFenced(): boolean {
  return existsSync(join(resolveOlympusHome(), '.hermes-update-in-progress'));
}

export async function checkHermesMaintenance(
  controller: DrainController,
  adapter: Pick<AgentAdapter, 'getHermesRuntime' | 'getBackgroundWork'>,
  taskIds: string[],
  isStopped: (taskId: string) => boolean = () => false,
) {
  const status = await controller.refreshStatus();
  if (!status.draining || status.activeRuns !== 0) return { ready: false, runtime: null, blockers: ['Active work has not drained.'] };
  try {
    if (!adapter.getBackgroundWork || !adapter.getHermesRuntime) throw new Error('Unsupported runtime.');
    // Includes Bot sessions and completed tasks: previews/native children can
    // outlive the foreground conversation. Unknown inventory fails closed.
    for (const taskId of taskIds) {
      const background = await adapter.getBackgroundWork(taskId);
      // A saved Stop is not live work. Require the server's explicit stop and
      // an empty durable receipt; retain the marker so maintenance cannot resume it.
      const receipt = background.checkpoint;
      const idleStop = isStopped(taskId) && background.continuation?.status === 'blocked'
        && background.continuation.reason === 'Stopped by user or interaction; explicit continuation is required.'
        && receipt?.saved === true && receipt.source === 'task-continuation-journal'
        && Array.isArray(receipt.pendingDelegationIds) && receipt.pendingDelegationIds.length === 0
        && receipt.undeliveredResultCount === 0;
      if (background.available !== true || !Array.isArray(background.work) || background.work.length
        || (background.continuation && background.continuation.status !== 'none' && !idleStop)) {
        return { ready: false, runtime: null, blockers: ['A task has background work or its state could not be checked.'] };
      }
    }
    const runtime = await adapter.getHermesRuntime(true);
    const after = await controller.refreshStatus();
    return { ready: runtime.available && !!runtime.revision && after.draining && after.activeRuns === 0, runtime, blockers: runtime.available ? [] : ['Hermes runtime verification failed.'] };
  } catch { return { ready: false, runtime: null, blockers: ['Hermes runtime verification is unavailable.'] }; }
}
