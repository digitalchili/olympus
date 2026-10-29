import { useEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, X } from 'lucide-react';
import type { RepositoryChange, RepositoryOverview, RepositoryReleaseMode, RepositoryReleasePreview } from '@shared/repository-releases';
import { actOnRepositoryRelease, fetchRepositoryChanges, previewRepositoryRelease, requestRepositoryRelease } from '../lib/api';
import { toErrorMessage } from '../lib/format';

const labels = { ready: 'Ready to publish', working: 'Still working', needs_attention: 'Needs attention', stopped: 'Stopped — work saved' };
const button = 'rounded-lg border border-zinc-200 px-3 py-2 text-left font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';
function ChangeList({ changes }: { changes: RepositoryChange[] }) {
  const groups = new Map<string, RepositoryChange[]>();
  for (const change of changes) groups.set(change.taskId, [...(groups.get(change.taskId) ?? []), change]);
  return <ul className="space-y-3">{[...groups.values()].map(rows => {
    const first = rows[0], files = [...new Set(rows.flatMap(row => row.changedFiles))];
    return <li key={first.taskId} className="min-w-0">
      <a className="break-words font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100" href={`/projects/${encodeURIComponent(first.projectId)}/tasks/${encodeURIComponent(first.taskId)}?profile=${encodeURIComponent(first.profileId)}`}>{first.title}</a>
      <div className="mt-1 flex flex-wrap gap-1">{[...new Set(rows.map(row => row.state))].map(state => <span key={state} className={`rounded px-1.5 py-0.5 text-[11px] ${state === 'ready' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : state === 'working' ? 'bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200'}`}>{labels[state]}</span>)}</div>
      {[...new Set(rows.map(row => row.reason))].map(reason => <p key={reason} className="mt-1 leading-relaxed text-zinc-500 dark:text-zinc-400">{reason}</p>)}
      {files.length > 0 && <details className="mt-1 text-zinc-500"><summary className="cursor-pointer">{files.length} changed {files.length === 1 ? 'file' : 'files'}</summary><ul className="mt-1 space-y-1 break-all font-mono text-[10px]">{files.map(file => <li key={file}>{file}</li>)}</ul></details>}
    </li>;
  })}</ul>;
}
function PublishPreview({ preview, busy, onPublish, onClose, error }: { preview: RepositoryReleasePreview; busy: boolean; onPublish: () => void; onClose: () => void; error: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} aria-label="Publish repository changes" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-700 shadow-xl backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{preview.mode === 'all' ? 'Wait for all' : "Publish what's ready"}</h2><button type="button" aria-label="Close publish preview" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <p className="mt-2 leading-relaxed">{preview.mode === 'all' ? 'Save this group and publish automatically after every included task finishes and passes checks.' : 'Publish these checked changes. The work left for later stays saved.'} New tasks and requests will not be added to this publish.</p>
    {preview.mode === 'all' && preview.included.some(row => row.state === 'stopped' || row.state === 'needs_attention') && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">Some included tasks need attention. This request will wait for them; stopped tasks will stay stopped. Choose ready changes instead if you want to leave them for later.</p>}
    <h3 className="mb-3 mt-5 font-semibold">Included in this publish</h3><ChangeList changes={preview.included} />
    {preview.excluded.length > 0 && <><h3 className="mb-3 mt-5 font-semibold">Left for later</h3><ChangeList changes={preview.excluded} /></>}
    <p className="mt-5 rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed dark:bg-zinc-800">Destination: <strong>{preview.targetBranch}</strong>. Olympus checks the combined version before pushing. Publishing may trigger your repository’s deployment service; a successful push alone does not confirm deployment.</p>
    {error && <p role="alert" className="mt-3 text-red-600 dark:text-red-400">{error}</p>}
    <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>Back</button><button type="button" className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900" disabled={busy} onClick={onPublish}>{busy ? 'Saving request…' : preview.mode === 'all' ? `Wait, then publish to ${preview.targetBranch}` : `Publish to ${preview.targetBranch}`}</button></div>
  </dialog>;
}
export function RepositoryChangesPanel({ overview, preview, busy, error, onPreview, onPublish, onClosePreview, onRetry, onCancel, onRefresh }: {
  overview: RepositoryOverview; preview: RepositoryReleasePreview | null; busy: boolean; error: string;
  onPreview: (mode: RepositoryReleaseMode) => void; onPublish: () => void; onClosePreview: () => void; onRetry: () => void; onCancel: () => void; onRefresh: () => void;
}) {
  const release = overview.release, pending = release && !['confirmed', 'cancelled'].includes(release.state);
  const count = new Set(overview.changes.map(row => row.taskId)).size;
  return <section aria-label="Repository changes" className="min-w-0 rounded-xl border border-zinc-200 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
    <details open className="group/repository"><summary className="flex cursor-pointer list-none items-center gap-2 p-3 [&::-webkit-details-marker]:hidden"><span className="flex-1 font-medium text-zinc-900 dark:text-zinc-100">Unpublished changes <span className="text-zinc-500">{count || ''}</span></span><ChevronRight size={14} className="shrink-0 transition-transform group-open/repository:rotate-90" /></summary>
      <div className="space-y-3 border-t border-zinc-100 p-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2"><span className="break-all text-[11px] text-zinc-500">{overview.repositoryName}</span><button type="button" aria-label="Refresh repository changes" onClick={onRefresh} disabled={busy} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"><RefreshCw size={13} /></button></div>
        {overview.hasHiddenWork && <p role="status" className="rounded-lg bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">Some repository work is unavailable in this profile. The full publish scope cannot be checked here.</p>}
        {count ? <div className="max-h-80 overflow-y-auto"><ChangeList changes={overview.changes} /></div> : <p>No unpublished task changes found.</p>}
        {release && <div role="status" className={`space-y-2 rounded-lg p-2.5 ${release.state === 'confirmed' ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-zinc-50 dark:bg-zinc-800'}`}>
          <p className="font-medium">{release.state === 'confirmed' ? 'On GitHub' : release.state === 'blocked' ? 'Publish needs attention' : release.state === 'cancelled' ? 'Publish request cancelled' : 'Publish request saved'}</p><p className="leading-relaxed">{release.message}</p>
          <details><summary className="cursor-pointer">Included tasks and checks</summary><div className="mt-2 space-y-3"><ChangeList changes={release.included} />{release.excluded.length > 0 && <><p className="font-medium">Left for later</p><ChangeList changes={release.excluded} /></>}{release.checks?.map((check, i) => <details key={i}><summary className="cursor-pointer break-words">{check.exitCode === 0 ? 'Passed' : 'Failed'}: {check.command.join(' ')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px]">{check.output}</pre></details>)}{release.commitSha && <p className="break-all font-mono text-[10px]">{release.targetBranch}: {release.commitSha}</p>}</div></details>
          {pending && <div className="flex flex-wrap gap-2">{['blocked', 'publishing'].includes(release.state) && <button type="button" className={button} disabled={busy} onClick={onRetry}>Retry same request</button>}<button type="button" className={button} disabled={busy} onClick={onCancel}>{release.state === 'publishing' ? 'Stop retrying' : 'Cancel publish request'}</button></div>}
        </div>}
        {!pending && count > 0 && !overview.hasHiddenWork && <div className="grid gap-2"><button type="button" data-release-mode="all" className={button} disabled={busy} onClick={() => onPreview('all')}>Wait for all<span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Publish this group when every task is ready.</span></button><button type="button" data-release-mode="ready" className={button} disabled={busy || !overview.changes.some(row => row.state === 'ready')} onClick={() => onPreview('ready')}>Publish what's ready<span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Review what is included and left for later.</span></button></div>}
        {error && !preview && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </details>
    {preview && <PublishPreview preview={preview} busy={busy} onPublish={onPublish} onClose={onClosePreview} error={error} />}
  </section>;
}
export function RepositoryChanges({ projectId, profileId }: { projectId: string; profileId: string }) {
  const [overview, setOverview] = useState<RepositoryOverview | null>(null);
  const [preview, setPreview] = useState<RepositoryReleasePreview | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), reading = useRef(false);
  async function refresh() {
    if (reading.current) return;
    reading.current = true;
    try { const view = await fetchRepositoryChanges(projectId, profileId); if (alive.current) setOverview(view); }
    catch (cause) { if (alive.current) setError(toErrorMessage(cause, 'Could not check repository changes.')); }
    finally { reading.current = false; }
  }
  useEffect(() => {
    alive.current = true; void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [projectId, profileId]);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (alive.current) setError(toErrorMessage(cause, 'Could not save this publish request.')); }
    finally { if (alive.current) setBusy(false); }
  }
  if (!overview) return error ? <section aria-label="Repository changes" className="rounded-xl border p-3 text-xs"><p role="alert">{error}</p><button type="button" onClick={() => { setError(''); void refresh(); }} className="mt-2 underline">Check again</button></section> : null;
  return <RepositoryChangesPanel overview={overview} preview={preview} busy={busy} error={error}
    onRefresh={() => { setError(''); void refresh(); }}
    onPreview={mode => void act(async () => { const value = await previewRepositoryRelease(projectId, profileId, mode); if (alive.current) setPreview(value); })}
    onPublish={() => void act(async () => { if (!preview) return; await requestRepositoryRelease(projectId, profileId, preview); if (alive.current) { setPreview(null); await refresh(); } })}
    onClosePreview={() => { setPreview(null); setError(''); }}
    onRetry={() => void act(async () => { if (overview.release) await actOnRepositoryRelease(projectId, profileId, overview.release.id, 'retry'); await refresh(); })}
    onCancel={() => void act(async () => { if (overview.release) await actOnRepositoryRelease(projectId, profileId, overview.release.id, 'cancel'); await refresh(); })} />;
}
