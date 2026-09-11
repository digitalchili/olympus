import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { StudioGitHubInstallation } from '@shared/types';
import { fetchProjectGitHubAccess, saveProjectGitHubAccess, type ProjectGitHubAccess as AccessState } from '../lib/api';
import { toErrorMessage } from '../lib/format';

interface ViewProps {
  accounts: StudioGitHubInstallation[];
  installationIds: number[];
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  canManage: boolean;
  disabled: boolean;
  error: string | null;
  saved: boolean;
  onToggle: (id: number) => void;
  onSave: () => void;
  onRetry: () => void;
}

export function ProjectGitHubAccessView({ accounts, installationIds, loading, saving, dirty, canManage, disabled, error, saved, onToggle, onSave, onRetry }: ViewProps) {
  const locked = loading || saving || disabled || !canManage;
  return (
    <section aria-label="GitHub source access" className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold">GitHub source access</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">Let this Project’s tasks read source repositories from selected accounts. Access is read-only; the main repository remains the publish destination.</p>
      {loading ? <p role="status" className="mt-3 text-xs text-zinc-500">Loading GitHub accounts…</p> : <>
        {accounts.length === 0 && !error && <p className="mt-3 text-xs text-zinc-500">No GitHub accounts connected. <Link to="/settings#github" className="underline">Connect an account</Link>.</p>}
        <div className="mt-3 space-y-2">
          {accounts.map(account => <label key={account.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">
            <input type="checkbox" value={account.id} checked={installationIds.includes(account.id)} disabled={locked} onChange={() => onToggle(account.id)} className="h-4 w-4 accent-zinc-900 disabled:opacity-40 dark:accent-zinc-100" />
            <span className="min-w-0"><span className="block truncate font-medium">{account.label}</span><span className="block truncate text-xs text-zinc-500">@{account.accountLogin}</span></span>
          </label>)}
        </div>
      </>}
      <p className="mt-3 text-xs leading-5 text-zinc-500">Only repositories available to each connection can be read. Newly enabled access is available on the next task message. Tasks check access to each source repository when they use it.</p>
      {!canManage && <p className="mt-2 text-xs text-zinc-500">Project manage access is required to change these accounts.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={locked || !dirty} onClick={onSave} className="h-9 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{saving ? 'Checking and saving…' : 'Save GitHub access'}</button>
        {error && !dirty && <button type="button" disabled={loading || saving} onClick={onRetry} className="text-xs underline">Retry</button>}
        {saved && <p role="status" className="text-xs text-zinc-500">GitHub access saved.</p>}
      </div>
    </section>
  );
}

export function ProjectGitHubAccess({ projectId, canManage, disabled = false }: { projectId: string; canManage: boolean; disabled?: boolean }) {
  const [state, setState] = useState<AccessState | null>(null);
  const [installationIds, setInstallationIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setLoading(true); setError(null); setSaved(false); setState(null); setInstallationIds([]);
    fetchProjectGitHubAccess(projectId).then(result => {
      if (request !== generation.current) return;
      setState(result); setInstallationIds(result.installationIds);
    }).catch(cause => {
      if (request === generation.current) setError(toErrorMessage(cause, 'Could not load GitHub source access'));
    }).finally(() => {
      if (request === generation.current) setLoading(false);
    });
    return () => { ++generation.current; };
  }, [projectId, reload]);

  const dirty = state !== null && (installationIds.length !== state.installationIds.length || installationIds.some(id => !state.installationIds.includes(id)));
  const save = async () => {
    if (!canManage || disabled || loading || saving || !dirty) return;
    const request = generation.current;
    setSaving(true); setError(null); setSaved(false);
    try {
      const result = await saveProjectGitHubAccess(projectId, installationIds);
      if (request !== generation.current) return;
      setState(result); setInstallationIds(result.installationIds); setSaved(true);
    } catch (cause) {
      if (request === generation.current) setError(toErrorMessage(cause, 'Could not save GitHub source access'));
    } finally {
      if (request === generation.current) setSaving(false);
    }
  };

  return <ProjectGitHubAccessView accounts={state?.accounts ?? []} installationIds={installationIds} loading={loading} saving={saving} dirty={dirty} canManage={canManage} disabled={disabled} error={error} saved={saved} onSave={() => void save()} onRetry={() => setReload(value => value + 1)} onToggle={id => {
    setInstallationIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    setSaved(false);
  }} />;
}
