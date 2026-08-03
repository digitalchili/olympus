import type { Task } from '@shared/types';

export function remoteProfileLabel(id: string | null | undefined): string | null {
  return id || null;
}

export function taskRoutingLabel(task: Task): string | null {
  const profile = remoteProfileLabel(task.profile_name);
  if (!profile || !task.routing_source) return null;
  return `${task.routing_source === 'manual' ? 'Manually' : 'Automatically'} routed to ${profile}`;
}
