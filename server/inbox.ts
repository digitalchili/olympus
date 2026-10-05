import type { InboxItem } from '../shared/inbox.js';
import type { Task } from '../shared/types.js';
import { getAllTasks } from './db/queries.js';
import { getProject } from './db/projects.js';
import { listOpenInteractions, hasUnansweredInteractions } from './db/interactions.js';
import { getQueuedTaskMessage } from './db/task-message-queue.js';
import { localProfileRegistry, type LocalProfileRegistry } from './local-profiles.js';
import { isProfileDeleting } from './profile-deletion.js';
import { canProfileAccessProject } from './project-access.js';
import { taskRunSnapshot } from './task-run-snapshot.js';
import { getRunStatus } from './live-chat.js';
import { getRecovery } from './run-recovery.js';
import { hasActiveTaskRun, hasTaskOperation, activeCollaborations } from './task-run-lifecycle.js';
import { isVerifying } from './coding-verification.js';

export function inboxTaskAccessible(task: Task, registry: LocalProfileRegistry): boolean {
  const profileId = task.handling_profile_id ?? task.profile_name ?? 'default';
  return task.kind !== 'bot' && !isProfileDeleting(profileId)
    && registry.publicProfiles().some(profile => profile.id === profileId)
    && (!task.project_id || canProfileAccessProject(task.project_id, profileId));
}

/** Installation-wide view for the local operator. Each task retains its handling profile's Project access. */
export function inboxSnapshot(registry = localProfileRegistry): InboxItem[] {
  const profiles = new Map(registry.publicProfiles().map(profile => [profile.id, profile]));
  const runs = new Map(taskRunSnapshot().map(run => [run.taskId, run]));
  const interactions = listOpenInteractions();
  const items: InboxItem[] = [];
  for (const task of getAllTasks()) {
    const profileId = task.handling_profile_id ?? task.profile_name ?? 'default';
    const profile = profiles.get(profileId);
    if (!profile || isProfileDeleting(profileId) || task.status === 'done') continue;
    if (task.project_id && !canProfileAccessProject(task.project_id, profileId)) continue;
    const run = runs.get(task.id);
    const live = getRunStatus(task.id);
    const interaction = interactions.find(item => item.taskId === task.id && item.profileName === profileId
      && item.olympusRunId === run?.runId
      && (item.status === 'delivery_unknown' || (live?.runId === run.runId && live.status === 'streaming')));
    const recovery = getRecovery(task.id);
    const recovering = recovery?.run_id === run?.runId && ['pending', 'waiting', 'dispatching'].includes(recovery?.state ?? '')
      && !getQueuedTaskMessage(task.id) && !!run && !hasUnansweredInteractions(task.id, run.runId);
    const collaboration = activeCollaborations.get(task.id);
    const busy = run?.status === 'streaming' || run?.status === 'compacting' || recovering
      || hasActiveTaskRun(task.id) || hasTaskOperation(task.id) || isVerifying(task.id)
      || (collaboration && !collaboration.settled);
    let category: InboxItem['category'];
    let summary: string;
    let actionLabel: string;
    if (interaction?.status === 'waiting') {
      category = 'questions'; summary = interaction.title;
      actionLabel = interaction.kind === 'approval' ? 'Review request' : 'Reply';
    } else if (interaction?.status === 'delivery_unknown') {
      category = 'help'; summary = 'Your response could not be confirmed. Check the task before trying again.';
      actionLabel = 'Open task';
    } else if (busy) {
      continue;
    } else if (task.status === 'in_review') {
      category = 'review'; summary = 'A result is ready for your review.'; actionLabel = 'Review result';
    } else if (run && ['error', 'stopped', 'done'].includes(run.status)) {
      category = 'help'; actionLabel = 'Open recovery options';
      summary = run.status === 'stopped' ? 'Work was stopped. Open the task to continue when you’re ready.'
        : run.status === 'done' ? 'The task is unfinished. Review its progress and next step.'
          : 'The run ended before completion. Review its progress and recovery options.';
    } else {
      continue;
    }
    items.push({
      key: [category, task.id, profileId, task.updated_at, run?.runId ?? '', interaction?.id ?? '', interaction?.status ?? ''].join(':'),
      taskId: task.id, title: task.title, profileId, profileName: profile.displayName,
      projectId: task.project_id ?? null, projectName: task.project_id ? getProject(task.project_id)?.name ?? null : null,
      category, summary, actionLabel, interactionId: interaction?.status === 'waiting' ? interaction.id : null,
      updatedAt: interaction?.requestedAt ?? run?.updatedAt ?? task.last_agent_response_at ?? task.updated_at,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId));
}
