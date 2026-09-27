import { useEffect, useState } from 'react';
import type { ProjectSecretMetadata } from '@shared/project-secrets';
import { deleteProjectSecret, fetchProjectSecrets } from '../lib/api';
import { SecretEntryDialog, type SecretEntryDraft } from './SecretEntryDialog';

export function ProjectSecretsSection({ projectId, projectName, disabled = false }: { projectId: string; projectName: string; disabled?: boolean }) {
  const [secrets, setSecrets] = useState<ProjectSecretMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SecretEntryDraft | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchProjectSecrets(projectId).then(result => { if (!cancelled) { setSecrets(result.secrets); setError(null); } })
      .catch(() => { if (!cancelled) setError('Could not load Project secrets.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, revision]);
  async function remove(name: string) {
    if (removing) return;
    setRemoving(name); setError(null);
    try { await deleteProjectSecret(projectId, name); setSecrets(current => current.filter(secret => secret.name !== name)); setConfirmRemove(null); }
    catch { setError('Could not remove the secret. Please try again.'); }
    finally { setRemoving(null); }
  }
  return <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
    <h2 className="text-sm font-medium">Secrets</h2>
    <p className="mt-1 text-xs text-zinc-500">Save API keys and connection details for this project. Values stay hidden and out of chat history. You can also paste NAME=value in a Project task’s chat.</p>
    {loading ? <p className="mt-3 text-xs text-zinc-500">Loading secrets…</p> : <ul className="mt-3 space-y-2">{secrets.map(secret => <li key={secret.name} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="break-all font-mono">{secret.name}</span><span className="flex gap-2"><button type="button" disabled={disabled || Boolean(removing)} onClick={() => setDraft({ name: secret.name })} className="underline disabled:opacity-40">Replace</button><button type="button" disabled={disabled || Boolean(removing)} onClick={() => setConfirmRemove(secret.name)} className="text-red-600 underline disabled:opacity-40">Remove</button></span></li>)}</ul>}
    {!loading && !error && secrets.length === 0 && <p className="mt-3 text-xs text-zinc-500">No secrets saved.</p>}
    {confirmRemove && <div className="mt-3 rounded-lg border border-red-200 p-3 text-xs dark:border-red-900"><p>Remove {confirmRemove}? Future runs will no longer receive it.</p><div className="mt-2 flex gap-3"><button type="button" disabled={Boolean(removing)} onClick={() => void remove(confirmRemove)} className="text-red-600 underline">{removing ? 'Removing…' : 'Confirm removal'}</button><button type="button" disabled={Boolean(removing)} onClick={() => setConfirmRemove(null)} className="underline">Cancel</button></div></div>}
    {error && <p role="alert" className="mt-3 text-xs text-red-600">{error} <button type="button" onClick={() => setRevision(value => value + 1)} className="underline">Retry</button></p>}
    <button type="button" disabled={disabled || Boolean(removing)} onClick={() => setDraft({})} className="mt-3 h-8 rounded-lg border border-zinc-200 px-3 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Add secrets</button>
    {draft && <SecretEntryDialog draft={draft} projectId={projectId} projectName={projectName} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); setRevision(value => value + 1); }} />}
  </section>;
}
