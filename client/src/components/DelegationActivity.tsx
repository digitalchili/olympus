import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, ChevronRight, CircleAlert, Clock3, Loader2, X } from 'lucide-react';
import type { DelegationRun, DelegationRunStatus } from '@shared/types';
import { isActiveDelegation, summarizeDelegationActivity } from '../lib/delegationActivity';

const STATUS_LABELS: Record<DelegationRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  stalled: 'Stalled',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  unknown: 'Unknown',
};

function formatAction(run: DelegationRun): string {
  if (run.current_action) return run.current_action.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  if (run.status === 'waiting') return 'Between turns';
  if (run.status === 'queued') return 'Waiting to start';
  if (run.status === 'unknown') return 'State could not be proven after restart';
  return STATUS_LABELS[run.status];
}

function formatElapsed(run: DelegationRun, now: number): string {
  const start = run.started_at ?? run.created_at;
  const end = run.completed_at ?? now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatLastActivity(run: DelegationRun, now: number): string {
  const seconds = Math.max(0, Math.floor((now - run.last_activity_at) / 1000));
  if (seconds < 5) return 'active now';
  if (seconds < 60) return `active ${seconds}s ago`;
  return `active ${Math.floor(seconds / 60)}m ago`;
}

function StatusIcon({ run }: { run: DelegationRun }) {
  if (run.status === 'running' || run.status === 'waiting' || run.status === 'queued') {
    return <Loader2 size={13} className="shrink-0 animate-spin text-sky-500" />;
  }
  if (run.status === 'completed') return <Check size={13} className="shrink-0 text-emerald-500" />;
  if (run.status === 'failed' || run.status === 'stalled' || run.status === 'timed_out') {
    return <CircleAlert size={13} className="shrink-0 text-red-500" />;
  }
  return <Clock3 size={13} className="shrink-0 text-zinc-400" />;
}

function WorkerRow({ run, now, detailed = false }: { run: DelegationRun; now: number; detailed?: boolean }) {
  const tokens = run.input_tokens + run.output_tokens + run.reasoning_tokens;
  return (
    <div className={detailed ? 'rounded-xl border border-zinc-200 p-3 dark:border-zinc-700' : ''}>
      <div className="flex min-w-0 items-start gap-2">
        <StatusIcon run={run} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
              Delegated worker {run.child_index + 1}
            </span>
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {STATUS_LABELS[run.status]}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="truncate">{formatAction(run)}</span>
            <span className="shrink-0">· {formatLastActivity(run, now)}</span>
          </div>
          {detailed && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              <span>Elapsed {formatElapsed(run, now)}</span>
              {run.model && <span>{run.model}</span>}
              <span>{run.api_calls} API call{run.api_calls === 1 ? '' : 's'}</span>
              <span>{tokens.toLocaleString()} tokens</span>
              <span>{run.files_touched} file{run.files_touched === 1 ? '' : 's'} touched</span>
              {run.cost_usd != null && <span>${run.cost_usd.toFixed(4)}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DelegationActivity({ runs }: { runs: DelegationRun[] }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const summary = summarizeDelegationActivity(runs);
  const sorted = useMemo(() => [...runs].sort((a, b) => {
    const activeDifference = Number(isActiveDelegation(b)) - Number(isActiveDelegation(a));
    return activeDifference || b.updated_at - a.updated_at;
  }), [runs]);

  useEffect(() => {
    if (!runs.some(isActiveDelegation)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runs]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      } else if (event.key === 'Tab') {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (runs.length === 0) return null;

  return (
    <>
      <section aria-label="Delegated worker activity" className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <Activity size={15} className="shrink-0 text-sky-500" />
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{summary.title}</span>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            View activity <ChevronRight size={13} />
          </button>
        </div>
        <div className="mt-2 space-y-2">
          {sorted.slice(0, 3).map((run) => <WorkerRow key={run.id} run={run} now={now} />)}
        </div>
      </section>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Delegated worker activity">
          <button
            type="button"
            tabIndex={-1}
            className="absolute inset-0 bg-black/25"
            aria-label="Close activity"
            onClick={() => {
              setOpen(false);
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />
          <aside className="relative flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex items-center border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Delegated worker activity</h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Visibility only · prompts and tool arguments stay private</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => {
                  setOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                }}
                className="ml-auto rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                aria-label="Close activity"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {sorted.map((run) => <WorkerRow key={run.id} run={run} now={now} detailed />)}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
