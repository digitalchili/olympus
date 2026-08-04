import type { Task } from '@shared/types';

export function profileLabel(id: string | null | undefined): string | null {
  return id || null;
}

export function taskProfileLabel(task: Task): string | null {
  const profile = profileLabel(task.profile_name);
  return profile ? `Local profile: ${profile}` : null;
}
