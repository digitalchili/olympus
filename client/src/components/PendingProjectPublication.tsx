import type { PendingProjectPublication as Publication } from '@shared/types';

export function PendingProjectPublication({ publication, disabled, queued = false, onResume, onAbandon }: {
  publication: Publication;
  disabled: boolean;
  queued?: boolean;
  onResume: () => void;
  onAbandon: () => void;
}) {
  queued = queued && !publication.failureReason;
  return <section aria-label="Pending GitHub publication" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <p className="font-semibold">{queued ? 'Resume queued' : publication.failureReason === 'branch_advanced' ? 'A GitHub branch has advanced.' : 'GitHub publication could not be confirmed.'}</p>
    {queued ? <p className="mt-1">Olympus will retry the saved commit after this turn finishes. No further action is needed.</p> : publication.failureReason === 'branch_advanced'
      ? <p className="mt-1">Your commit is saved. Stop retrying this publication, then ask the task to merge the latest target branch, run checks, and publish again.</p>
      : <p className="mt-1">Resume the saved commit to <span className="font-mono">{publication.targetBranches.join(', ')}</span>.</p>}
    {publication.commitSha && <p className="mt-1">Commit <code title={publication.commitSha}>{publication.commitSha.slice(0, 7)}</code></p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={disabled || queued} onClick={onResume} className="rounded-lg border border-amber-300 px-3 py-2 font-medium disabled:opacity-40 dark:border-amber-800">Resume publication</button>
      <button type="button" disabled={disabled} onClick={() => {
        if (window.confirm('Stop retrying this publication? This does not undo any changes already accepted by GitHub. Your saved commit and local files remain available.')) onAbandon();
      }} className="rounded-lg px-3 py-2 underline disabled:opacity-40">Stop retrying this publication</button>
    </div>
  </section>;
}
