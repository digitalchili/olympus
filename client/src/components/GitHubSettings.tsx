import { Code2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { StudioGitHubInstallation } from '@shared/types';
import { connectStudioGitHub, fetchStudioGitHubStatus } from '../lib/api';
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

export function GitHubSettings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const callbackInstallationId = Number(searchParams.get('installationId'));
  const [configured, setConfigured] = useState(false);
  const [installations, setInstallations] = useState<StudioGitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubOwnerType, setGitHubOwnerType] = useState<'' | 'personal' | 'organization'>('');
  const [organizationHandle, setOrganizationHandle] = useState('');

  const validOrganizationHandle = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(
    organizationHandle.trim(),
  );

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

  return (
    <section id="github" aria-labelledby="github-settings-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="github-settings-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">GitHub connections</h2>
          <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
            Connect read-only GitHub App installations globally. Projects can link one verified repository from these connections.
          </p>
        </div>
        {configured && (
          <button type="button" disabled={working} onClick={() => void connectGitHub()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
            <Code2 size={16} /> Connect GitHub account
          </button>
        )}
      </div>

      {!configured && !loading && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">Create the Olympus GitHub App</p>
          <p className="mt-1">GitHub will create and install the read-only Olympus App. No write tokens, push, merge, or deployment authority is requested in this slice.</p>
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

      {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

      <div className="mt-4 space-y-2">
        {loading ? <p className="text-sm text-zinc-500">Loading GitHub connections…</p> : installations.length === 0 ? (
          <p className="text-sm text-zinc-500">No verified GitHub installations yet.</p>
        ) : installations.map((installation) => (
          <div key={installation.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
            <div className="min-w-0">
              <p className="truncate font-medium text-zinc-800 dark:text-zinc-200">{installation.accountLogin}</p>
              <p className="text-xs text-zinc-500">{installation.accountType} installation · verified</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"><LockKeyhole size={12} /> Read-only</span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800"><ShieldCheck size={14} /> Credentials are managed only here; Projects store non-secret repository metadata.</div>
    </section>
  );
}
