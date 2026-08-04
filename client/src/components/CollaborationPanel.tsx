import { AlertTriangle, CheckCircle2, Loader2, MessageSquareText, Users } from 'lucide-react';
import type { CollaborationContribution, CollaborationRun, CollaborationRunStatus } from '@shared/types';
import { MarkdownContent } from './MarkdownContent';

export function isCollaborationActive(status: CollaborationRunStatus): boolean {
  return status === 'gathering' || status === 'proposal' || status === 'review' || status === 'synthesizing';
}

function statusLabel(status: CollaborationRunStatus): string {
  const labels: Record<CollaborationRunStatus, string> = {
    gathering: 'Gathering profiles',
    proposal: 'Independent proposals',
    review: 'Cross-review',
    synthesizing: 'Chair synthesis',
    completed: 'Completed',
    completed_with_errors: 'Completed with issues',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return labels[status];
}

function contributionStatus(contribution: CollaborationContribution) {
  if (contribution.status === 'running' || contribution.status === 'pending') {
    return <Loader2 size={13} className="animate-spin text-violet-500" />;
  }
  if (contribution.status === 'completed') {
    return <CheckCircle2 size={13} className="text-emerald-500" />;
  }
  return <AlertTriangle size={13} className="text-amber-500" />;
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function PhaseSection({
  title,
  contributions,
}: {
  title: string;
  contributions: CollaborationContribution[];
}) {
  if (contributions.length === 0) return null;
  return (
    <section className="space-y-2.5">
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">{title}</h3>
      {contributions.map((contribution) => (
        <article
          key={contribution.id}
          className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/70"
        >
          <div className="mb-2 flex items-center gap-2">
            {contributionStatus(contribution)}
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              {contribution.profile_label}
            </span>
            <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
              {formatTime(contribution.completed_at ?? contribution.started_at)}
            </span>
          </div>
          {contribution.content ? (
            <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              <MarkdownContent content={contribution.content} />
            </div>
          ) : contribution.error ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">{contribution.error}</p>
          ) : (
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              {contribution.phase === 'review' ? 'Reviewing the other proposals…' : 'Preparing a proposal…'}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}

export function CollaborationLiveBanner({
  run,
  onOpen,
}: {
  run: CollaborationRun;
  onOpen: () => void;
}) {
  const activeProfiles = Array.from(new Set(run.contributions.map((item) => item.profile_label)));
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-auto mb-2 flex w-full max-w-[760px] items-center gap-2.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-left text-xs text-violet-800 transition hover:bg-violet-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300 dark:hover:bg-violet-950/50"
    >
      <Loader2 size={14} className="shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 truncate">
        {statusLabel(run.status)}{activeProfiles.length ? ` · ${activeProfiles.join(', ')}` : ''}
      </span>
      <span className="shrink-0 font-semibold">View collaboration</span>
    </button>
  );
}

export function CollaborationPanel({ runs }: { runs: CollaborationRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
            <Users size={19} />
          </div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">No collaboration yet</h2>
          <p className="mt-1 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            Type <span className="font-mono">@</span> in the Answer composer to invite local profiles. Their visible proposals and cross-review will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
      <div className="mx-auto w-full max-w-[760px] space-y-5">
        {runs.map((run) => {
          const proposals = run.contributions.filter((item) => item.phase === 'proposal');
          const reviews = run.contributions.filter((item) => item.phase === 'review');
          const active = isCollaborationActive(run.status);
          return (
            <article key={run.id} className="space-y-4">
              <header className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  active
                    ? 'bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400'
                    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                }`}>
                  {active ? <Loader2 size={15} className="animate-spin" /> : <MessageSquareText size={15} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Round {run.round}</h2>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {statusLabel(run.status)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">{run.question}</p>
                </div>
              </header>
              <PhaseSection title="Independent proposals" contributions={proposals} />
              <PhaseSection title="Cross-review" contributions={reviews} />
            </article>
          );
        })}
      </div>
    </div>
  );
}
