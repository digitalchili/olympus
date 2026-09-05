import type { RunFailureNotice } from '../lib/runFailurePresentation';

export function RunFailureBanner({ notice }: { notice: RunFailureNotice | null }) {
  if (!notice) return null;

  return (
    <div className="w-full min-w-0 max-w-[760px] mx-auto mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-sm dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100" role="status">
      <div className="font-semibold">{notice.title}</div>
      <div className="mt-0.5 text-amber-800 dark:text-amber-200">{notice.detail}</div>
    </div>
  );
}
