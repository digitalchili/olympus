import type { PendingProjectPublication as Publication } from '@shared/types';

export function PendingProjectPublication({ publication, disabled, onResume, onAbandon }: {
  publication: Publication;
  disabled: boolean;
  onResume: () => void;
  onAbandon: () => void;
}) {
  return <section aria-label="Pending GitHub publication" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <p className="font-semibold">GitHub publication could not be confirmed.</p>
    <p className="mt-1">Resume the saved commit to <span className="font-mono">{publication.targetBranches.join(', ')}</span>.</p>
    {publication.commitSha && <p className="mt-1">Commit <code title={publication.commitSha}>{publication.commitSha.slice(0, 7)}</code></p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={disabled} onClick={onResume} className="rounded-lg border border-amber-300 px-3 py-2 font-medium disabled:opacity-40 dark:border-amber-800">Resume publication</button>
      <button type="button" disabled={disabled} onClick={() => {
        if (window.confirm('Stop retrying this publication? This does not undo any changes already accepted by GitHub. Your saved commit and local files remain available.')) onAbandon();
      }} className="rounded-lg px-3 py-2 underline disabled:opacity-40">Stop retrying this publication</button>
    </div>
  </section>;
}
