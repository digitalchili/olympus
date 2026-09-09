import { isRecovering, type RunFailureNotice } from '../lib/runFailurePresentation';

export function RunFailureBanner({ notice, recoveryState, onContinue, onPause, busy = false }: {
  notice: RunFailureNotice | null; recoveryState?: string | null;
  onContinue?: () => void; onPause?: () => void; busy?: boolean;
}) {
  if (!notice) return null;
  const recovering = isRecovering(recoveryState);
  return (
    <div className="w-full min-w-0 max-w-[760px] mx-auto mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 shadow-sm dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100" role="status">
      <div className="font-semibold">{recovering ? (recoveryState === 'waiting' ? 'Waiting to resume' : 'Resuming task…') : notice.title}</div>
      <div className="mt-1 text-amber-800 dark:text-amber-200">{recovering
        ? recoveryState === 'waiting'
          ? 'The task is not running. Olympus is waiting for background work or recovery evidence before trying again.'
          : 'The last run ended before completion. Olympus is checking saved progress and will try to resume shortly. You can leave this page open or come back later.'
        : recoveryState === 'exhausted'
          ? 'Automatic retries have stopped. Review the saved progress, then continue the task when you are ready.'
          : notice.detail}</div>
      {recovering && onPause && <button type="button" className="mt-2 underline disabled:opacity-50" disabled={busy} onClick={onPause}>Pause automatic recovery</button>}
      {!recovering && onContinue && <button type="button" className="mt-3 rounded-md bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900" disabled={busy} onClick={onContinue}>{busy ? 'Starting…' : 'Continue task'}</button>}
    </div>
  );
}
