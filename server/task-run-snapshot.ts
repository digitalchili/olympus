import type { TaskRunState } from '../shared/types.js';
import { hasRecordedTaskAgentRun, listLatestTaskAgentRuns } from './db/task-agent-runs.js';
import { getRunStatuses } from './live-chat.js';

export function taskRunSnapshot(): TaskRunState[] {
  const savedRuns = new Map<string, TaskRunState>(listLatestTaskAgentRuns().map(run => [run.taskId, run]));
  for (const live of getRunStatuses()) {
    const saved = savedRuns.get(live.taskId);
    if (!saved || live.startedAt > saved.startedAt ||
      // A newly admitted live run can precede its DB insert within the same millisecond.
      (live.startedAt === saved.startedAt && live.runId !== saved.runId && !hasRecordedTaskAgentRun(live.runId)) ||
      (live.runId === saved.runId && (saved.status === 'streaming' || saved.status === 'compacting'))) {
      savedRuns.set(live.taskId, live);
    }
  }
  return [...savedRuns.values()];
}
