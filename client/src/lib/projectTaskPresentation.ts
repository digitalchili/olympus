type ProjectTask = {
  id: string;
  project_id: string | null;
};

type ProjectIdentity = {
  id: string;
};

const PROJECT_CHIP_PALETTE = [
  'bg-blue-50 text-blue-700 ring-blue-200/70 hover:bg-blue-100 dark:bg-blue-950/35 dark:text-blue-300 dark:ring-blue-800/60 dark:hover:bg-blue-950/55',
  'bg-emerald-50 text-emerald-700 ring-emerald-200/70 hover:bg-emerald-100 dark:bg-emerald-950/35 dark:text-emerald-300 dark:ring-emerald-800/60 dark:hover:bg-emerald-950/55',
  'bg-amber-50 text-amber-700 ring-amber-200/70 hover:bg-amber-100 dark:bg-amber-950/35 dark:text-amber-300 dark:ring-amber-800/60 dark:hover:bg-amber-950/55',
  'bg-violet-50 text-violet-700 ring-violet-200/70 hover:bg-violet-100 dark:bg-violet-950/35 dark:text-violet-300 dark:ring-violet-800/60 dark:hover:bg-violet-950/55',
  'bg-rose-50 text-rose-700 ring-rose-200/70 hover:bg-rose-100 dark:bg-rose-950/35 dark:text-rose-300 dark:ring-rose-800/60 dark:hover:bg-rose-950/55',
  'bg-cyan-50 text-cyan-700 ring-cyan-200/70 hover:bg-cyan-100 dark:bg-cyan-950/35 dark:text-cyan-300 dark:ring-cyan-800/60 dark:hover:bg-cyan-950/55',
] as const;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function projectChipClasses(projectId: string): string {
  return PROJECT_CHIP_PALETTE[stableHash(projectId) % PROJECT_CHIP_PALETTE.length];
}

export function projectTaskPath(task: ProjectTask, project?: ProjectIdentity): string {
  if (task.project_id) {
    return `/projects/${encodeURIComponent(task.project_id)}/tasks/${encodeURIComponent(task.id)}`;
  }
  return `/tasks/${encodeURIComponent(task.id)}`;
}
