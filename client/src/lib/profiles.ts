import type { HermesProfile, Task } from '@shared/types';

export function profileLabel(id: string | null | undefined, profiles: HermesProfile[] = []): string | null {
  if (!id) return null;
  return profiles.find((profile) => profile.id === id)?.displayName || id;
}

export function taskProfileLabel(task: Task, profiles: HermesProfile[] = []): string | null {
  const profile = profileLabel(task.profile_name, profiles);
  return profile ? `Local profile: ${profile}` : null;
}
