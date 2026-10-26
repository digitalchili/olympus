import type { Task } from '@shared/types';

export function RepositoryQueueNotice({ queue, compact = false }: { queue: Task['repositoryQueue']; compact?: boolean }) {
  if (!queue) return null;
  return <div role="status" className={`rounded-md border border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100 ${compact ? 'mt-3 p-2 text-xs' : 'mx-3 mt-3 p-3 text-sm sm:mx-6'}`}>
    <p className="font-medium">{queue.message}</p>
    {!compact && <p className="mt-1 text-amber-800 dark:text-amber-200">{queue.state === 'waiting'
      ? 'Your request is saved. This task will start automatically when the earlier work is ready.'
      : 'Saved work is preserved. Olympus will continue automatically once this is resolved.'}</p>}
  </div>;
}
