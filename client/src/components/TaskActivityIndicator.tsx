import { useEffect, useState } from 'react';
import type { TaskRunState } from '@shared/types';

/** Indeterminate activity: an agent has no meaningful percentage complete. */
export function TaskActivityIndicator({ run, compact = false }: { run?: TaskRunState; compact?: boolean }) {
  const active = run?.status === 'streaming' || run?.status === 'compacting';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || compact) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, compact, run?.runId]);
  if (!active) return null;
  const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const label = run.status === 'compacting' ? 'Compacting' : 'Running';
  return <div className={compact ? 'mt-3' : 'mt-3 w-full'}>
    {!compact && <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-emerald-700 dark:text-emerald-300">
      <span>{label}</span><span className="tabular-nums" aria-label="Elapsed time">{elapsed}</span>
    </div>}
    <div role="progressbar" aria-label={`${label} — completion time unknown`} className="task-activity-track h-1 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-950">
      <div className="task-activity-bar h-full w-1/3 rounded-full bg-emerald-500 dark:bg-emerald-400" />
    </div>
  </div>;
}
