import { ChevronDown, Inbox, Settings } from 'lucide-react';
import { useState } from 'react';
import type { HermesChannel, HermesChannelHealth } from '@shared/types';
import { ProfileLink } from '../contexts/ProfileContext';

const HEALTH: Record<HermesChannelHealth, { label: string; dot: string }> = {
  healthy: { label: 'Connected', dot: 'bg-emerald-500' },
  degraded: { label: 'Needs attention', dot: 'bg-amber-500' },
  unknown: { label: 'Status unavailable', dot: 'bg-zinc-400' },
  inactive: { label: 'Inactive', dot: 'bg-zinc-400' },
};

export function ChannelInboxCard({ channel }: { channel: HermesChannel }) {
  const [expanded, setExpanded] = useState(true);
  const health = HEALTH[channel.health];
  const contentId = `channel-inbox-${channel.id}`;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-2 p-3.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60"
        >
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <Inbox size={15} strokeWidth={2.3} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {channel.displayLabel} Inbox
              </span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                Pinned
              </span>
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className={`h-1.5 w-1.5 rounded-full ${health.dot}`} />
              Active · {health.label}
            </span>
          </span>
          <ChevronDown
            size={16}
            className={`mt-1 shrink-0 text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {expanded && (
        <div id={contentId} className="border-t border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Latest</p>
          <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">No channel messages in Olympus yet.</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Hermes owns this connection.</p>
            <ProfileLink
              to="/settings#channels"
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            >
              <Settings size={12} />
              Disconnect in settings
            </ProfileLink>
          </div>
        </div>
      )}
    </article>
  );
}
