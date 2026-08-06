import { ApiError } from './api';

export type QueuedSteerOutcome = 'steered' | 'queued' | 'follow-up';

export async function deliverQueuedSteer(
  steer: () => Promise<{ steered: boolean; queued: boolean }>,
  sendFollowUp: () => Promise<void>,
): Promise<QueuedSteerOutcome> {
  try {
    const result = await steer();
    return result.steered ? 'steered' : 'queued';
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
    await sendFollowUp();
    return 'follow-up';
  }
}
