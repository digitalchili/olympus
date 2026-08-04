import type { CollaborationRun } from '@shared/types';

type CollaborationVisibilityMessage = {
  id: string;
  role: string;
  content: string;
  created_at: number;
};

/** Identify chair replies produced by persisted collaboration rounds. */
export function collaborationAssistantMessageIds(
  messages: CollaborationVisibilityMessage[],
  runs: CollaborationRun[],
): Set<string> {
  const ids = new Set<string>();
  let precedingUser: CollaborationVisibilityMessage | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      precedingUser = message;
      continue;
    }
    if (message.role !== 'assistant' || !precedingUser) continue;

    const matchingRun = runs.some((run) => (
      run.question === precedingUser?.content
      && Math.abs(run.created_at - precedingUser.created_at) < 30_000
    ));
    if (matchingRun) ids.add(message.id);
    precedingUser = null;
  }

  return ids;
}
