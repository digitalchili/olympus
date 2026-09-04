import type { AgentModelResolution, AgentRuntimeModel } from '@shared/types';

const CHAT_COLUMN_CLASS = 'w-full min-w-0 max-w-[760px] mx-auto';

function runtimeModelLabel(value: AgentRuntimeModel): string {
  const identity = [value.provider, value.model].filter(Boolean).join(':') || 'Unknown model';
  return value.reasoningEffort ? `${identity} (${value.reasoningEffort})` : identity;
}

export function RunModelResolution({ resolution }: { resolution: AgentModelResolution }) {
  const requested = runtimeModelLabel(resolution.requested);
  const actual = runtimeModelLabel(resolution.actual);
  const changed = requested !== actual;
  return (
    <div className={`${CHAT_COLUMN_CLASS} mb-2 rounded-lg border px-3 py-2 text-xs ${changed ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100' : 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-300'}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {changed ? (
          <><span className="font-semibold">Requested:</span><span>{requested}</span><span aria-hidden="true">→</span><span className="font-semibold">Actual:</span><span>{actual}</span></>
        ) : (
          <><span className="font-semibold">Model:</span><span>{actual}</span></>
        )}
      </div>
      {resolution.fallbackReason && <p className="mt-1 text-amber-700 dark:text-amber-300">{resolution.fallbackReason}</p>}
    </div>
  );
}
