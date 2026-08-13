import {
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  ExternalLink,

  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { StudioGitHubInstallation } from '@shared/types';
import {
  connectStudioGitHub,
  deleteStudioGitHubInstallation,
  fetchStudioGitHubStatus,
  updateStudioGitHubInstallation,
} from '../lib/api';
import { toErrorMessage } from '../lib/format';

function followGitHubAction(action: {
  url: string;
  method: 'GET' | 'POST';
  fields: Record<string, string>;
}) {
  if (action.method === 'GET') {
    window.location.assign(action.url);
    return;
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action.url;
  form.hidden = true;
  for (const [name, value] of Object.entries(action.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function installationSettingsUrl(installation: StudioGitHubInstallation) {
  return installation.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}

export function GitHubSettings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const callbackInstallationId = Number(searchParams.get('installationId'));
  const [configured, setConfigured] = useState(false);
  const [installations, setInstallations] = useState<StudioGitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [busyInstallationId, setBusyInstallationId] = useState<number | null>(null);
  const [editingInstallationId, setEditingInstallationId] = useState<number | null>(null);
  const [deletingInstallationId, setDeletingInstallationId] = useState<number | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [githubOwnerType, setGitHubOwnerType] = useState<'' | 'personal' | 'organization'>('');
  const [organizationHandle, setOrganizationHandle] = useState('');

  const validOrganizationHandle = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(
    organizationHandle.trim(),
  );

  async function refreshConnections() {
    const status = await fetchStudioGitHubStatus();
    setConfigured(status.configured);
    setInstallations(status.installations);
  }

  useEffect(() => {
    let cancelled = false;
    fetchStudioGitHubStatus()
      .then((status) => {
        if (cancelled) return;
        setConfigured(status.configured);
        setInstallations(status.installations);
        if (Number.isSafeInteger(callbackInstallationId) && callbackInstallationId > 0) {
          setSearchParams({}, { replace: true });
        }
      })
      .catch((cause) => { if (!cancelled) setError(toErrorMessage(cause, 'Could not load GitHub settings')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [callbackInstallationId, setSearchParams]);

  async function connectGitHub() {
    if (!configured && !githubOwnerType) {
      setError('Choose a personal account or organization.');
      return;
    }
    if (!configured && githubOwnerType === 'organization' && !validOrganizationHandle) {
      setError('Enter a valid GitHub organization handle.');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      followGitHubAction(await connectStudioGitHub(
        githubOwnerType === 'organization' ? organizationHandle.trim() : null,
      ));
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not start GitHub connection'));
      setWorking(false);
    }
  }

  function startEditing(installation: StudioGitHubInstallation) {
    setEditingInstallationId(installation.id);
    setDeletingInstallationId(null);
    setLabelDraft(installation.label);
    setError(null);
  }

  async function saveLabel(installationId: number) {
    setBusyInstallationId(installationId);
    setError(null);
    try {
      const { installation } = await updateStudioGitHubInstallation(installationId, labelDraft);
      setInstallations((current) => current.map((item) => item.id === installationId ? installation : item));
      setEditingInstallationId(null);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not update GitHub connection'));
    } finally {
      setBusyInstallationId(null);
    }
  }

  async function disconnectInstallation(installationId: number) {
    setBusyInstallationId(installationId);
    setError(null);
    try {
      await deleteStudioGitHubInstallation(installationId);
      await refreshConnections();
      setDeletingInstallationId(null);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not disconnect GitHub account'));
    } finally {
      setBusyInstallationId(null);
    }
  }

  return (
    <section id="github" aria-labelledby="git-providers-title" className="space-y-3">
      <div>
        <h2 id="git-providers-title" className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Git providers</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Connect accounts Olympus can use to create branches, commit, and push changes for Projects.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
              <Code2 size={22} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">GitHub</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">GitHub App · read–write repository access</p>
            </div>
          </div>
          {configured && (
            <button type="button" disabled={working} onClick={() => void connectGitHub()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
              <Plus size={16} /> Add GitHub account
            </button>
          )}
        </div>

        {!configured && !loading && (
          <div className="m-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Create the Olympus GitHub App</p>
            <p className="mt-1">GitHub will create the private Olympus App with read–write Contents access. Olympus uses it for feature branches, commits, and pushes; credentials remain server-side.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">App owner
                <select value={githubOwnerType} onChange={(event) => setGitHubOwnerType(event.target.value as '' | 'personal' | 'organization')} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                  <option value="">Select owner type</option>
                  <option value="personal">Personal account</option>
                  <option value="organization">Organization</option>
                </select>
              </label>
              {githubOwnerType === 'organization' && (
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Organization handle
                  <input type="text" value={organizationHandle} onChange={(event) => setOrganizationHandle(event.target.value)} placeholder="github-organization" autoComplete="off" spellCheck={false} aria-invalid={organizationHandle.length > 0 && !validOrganizationHandle} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 aria-[invalid=true]:border-red-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end"><button type="button" disabled={working || !githubOwnerType || (githubOwnerType === 'organization' && !validOrganizationHandle)} onClick={() => void connectGitHub()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"><Code2 size={16} /> Continue with GitHub</button></div>
          </div>
        )}

        {error && <div role="alert" className="m-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

        <div aria-live="polite">
          {loading ? <p className="p-4 text-sm text-zinc-500">Loading GitHub connections…</p> : installations.length === 0 ? (
            <div className="p-6 text-center">
              <Code2 size={24} className="mx-auto text-zinc-300 dark:text-zinc-700" />
              <p className="mt-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">No GitHub accounts connected</p>
              <p className="mt-1 text-xs text-zinc-500">Connect GitHub account access to link repositories to Projects.</p>
            </div>
          ) : installations.map((installation) => {
            const editing = editingInstallationId === installation.id;
            const deleting = deletingInstallationId === installation.id;
            const busy = busyInstallationId === installation.id;
            const readWrite = installation.permissionMode === 'read_write';
            return (
              <div key={installation.id} className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                      {installation.accountLogin.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{installation.label}</p>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${readWrite ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'}`}>
                          {readWrite ? <Check size={11} /> : <CircleAlert size={11} />}
                          {readWrite ? 'Read & write' : 'Upgrade required'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-500">@{installation.accountLogin} · {installation.accountType} · Installation #{installation.id}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    {!readWrite && <a href={installationSettingsUrl(installation)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300"><CircleAlert size={13} /> Upgrade permissions</a>}
                    <a href={installationSettingsUrl(installation)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"><ExternalLink size={13} /> Manage on GitHub</a>
                    <button type="button" title="Edit connection" aria-label={`Edit connection ${installation.label}`} onClick={() => startEditing(installation)} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"><Pencil size={15} /></button>
                    <button type="button" title="Delete connection" aria-label={`Delete connection ${installation.label}`} onClick={() => { setDeletingInstallationId(installation.id); setEditingInstallationId(null); setError(null); }} className="rounded-lg p-2 text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"><Trash2 size={15} /></button>
                  </div>
                </div>

                {editing && (
                  <form className="mx-4 mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950" onSubmit={(event) => { event.preventDefault(); void saveLabel(installation.id); }}>
                    <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Connection name
                      <input autoFocus value={labelDraft} maxLength={80} onChange={(event) => setLabelDraft(event.target.value)} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
                    </label>
                    <p className="mt-1.5 text-xs text-zinc-500">This label is only shown in Olympus. Repository access remains managed by GitHub.</p>
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" onClick={() => setEditingInstallationId(null)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"><X size={13} /> Cancel</button>
                      <button type="submit" disabled={busy || !labelDraft.trim()} className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"><Check size={13} /> Save changes</button>
                    </div>
                  </form>
                )}

                {deleting && (
                  <div className="mx-4 mb-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/30">
                    <p className="text-sm font-semibold text-red-800 dark:text-red-200">Disconnect account?</p>
                    <p className="mt-1 text-xs leading-5 text-red-700 dark:text-red-300">Olympus will forget this connection. GitHub App access is revoked separately on GitHub. Accounts linked to Projects cannot be disconnected.</p>
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" onClick={() => setDeletingInstallationId(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white/70 dark:text-zinc-200">Cancel</button>
                      <button type="button" disabled={busy} onClick={() => void disconnectInstallation(installation.id)} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"><Trash2 size={13} /> Delete connection</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-2"><ShieldCheck size={14} /> Credentials are managed only here; Projects store non-secret repository metadata.</span>
          <span className="inline-flex items-center gap-1">Feature branches and pull requests <ChevronRight size={13} /></span>
        </div>
      </div>
    </section>
  );
}
