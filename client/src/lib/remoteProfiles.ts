import type { Task } from '@shared/types';

const PROFILE_LABELS: Record<string, string> = {
  som: 'Som',
  somchai: 'Somchai',
  somboon: 'Somboon',
};

export function remoteProfileLabel(id: string | null | undefined): string | null {
  return id ? PROFILE_LABELS[id] ?? id : null;
}

export function taskRoutingLabel(task: Task): string | null {
  const profile = remoteProfileLabel(task.profile_name);
  if (!profile || !task.routing_source) return null;
  return `${task.routing_source === 'manual' ? 'Manually' : 'Automatically'} routed to ${profile}`;
}
