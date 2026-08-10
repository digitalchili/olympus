import { Code2, LockKeyhole, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type {
  StudioGitHubInstallation,
  StudioGitHubRepository,
  StudioProject,
} from '@shared/types';
import {
  connectStudioGitHub,
  fetchStudioGitHubStatus,
  fetchStudioProjects,
  fetchStudioRepositories,
  importStudioProject,
} from '../lib/api';
import {
  initialStudioRepositoryId,
  selectableStudioRepositories,
} from '../lib/studio-projects';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Studio request failed.';
}

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

export function StudioProjectsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const callbackInstallationId = Number(searchParams.get('installationId'));
  const [configured, setConfigured] = useState(false);
  const [installations, setInstallations] = useState<StudioGitHubInstallation[]>([]);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [repositories, setRepositories] = useState<StudioGitHubRepository[]>([]);
  const [installationId, setInstallationId] = useState<number | null>(
    Number.isSafeInteger(callbackInstallationId) && callbackInstallationId > 0
      ? callbackInstallationId
      : null,
  );
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
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
    Promise.all([fetchStudioGitHubStatus(), fetchStudioProjects()])
      .then(([status, projectResult]) => {
        if (cancelled) return;
        setConfigured(status.configured);
        setInstallations(status.installations);
        setProjects(projectResult.projects);
        if (!installationId && status.installations.length === 1) {
          setInstallationId(status.installations[0].id);
        }
      })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [installationId]);

  useEffect(() => {
    if (!installationId) {
      setRepositories([]);
      setRepositoryId(null);
      return;
    }
    let cancelled = false;
    setWorking(true);
    setError(null);
    fetchStudioRepositories(installationId)
      .then(({ repositories: available }) => {
        if (cancelled) return;
        setRepositories(available);
      })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setWorking(false); });
    return () => { cancelled = true; };
  }, [installationId]);

  const selectableRepositories = useMemo(
    () => selectableStudioRepositories(repositories, projects),
    [repositories, projects],
  );

  useEffect(() => {
    setRepositoryId((current) => (
      current && selectableRepositories.some((repository) => repository.id === current)
        ? current
        : initialStudioRepositoryId(repositories, projects)
    ));
  }, [projects, repositories, selectableRepositories]);

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
      setError(errorMessage(cause));
      setWorking(false);
    }
  }

  async function addProject() {
    if (!installationId || !repositoryId) return;
    setWorking(true);
    setError(null);
    try {
      const { project } = await importStudioProject(installationId, repositoryId);
      setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setRepositoryId(null);
      setSearchParams({}, { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Studio projects</h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
              Connect selected GitHub repositories. Imported projects remain read-only until a separately reviewed executor capability is approved.
            </p>
          </div>
          {configured && (
            <button
              type="button"
              disabled={working}
              onClick={() => void connectGitHub()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              <Code2 size={16} />
              Connect another GitHub account
            </button>
          )}
        </div>

        {!configured && !loading && (
          <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Connect GitHub</p>
            <p className="mt-1">
              Choose which repositories Olympus can access. You can revoke access at any time.
              GitHub will ask you to create and install the read-only Olympus App on the first connection.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                App owner
                <select
                  value={githubOwnerType}
                  onChange={(event) => setGitHubOwnerType(event.target.value as '' | 'personal' | 'organization')}
                  className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                >
                  <option value="">Select owner type</option>
                  <option value="personal">Personal account</option>
                  <option value="organization">Organization</option>
                </select>
              </label>
              {githubOwnerType === 'organization' && (
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Organization handle
                  <input
                    type="text"
                    value={organizationHandle}
                    onChange={(event) => setOrganizationHandle(event.target.value)}
                    placeholder="github-organization"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={organizationHandle.length > 0 && !validOrganizationHandle}
                    className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 aria-[invalid=true]:border-red-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <span className="mt-1 block font-normal text-zinc-500">
                    GitHub will verify that your account may create and install Apps for this organization.
                  </span>
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={working || !githubOwnerType || (githubOwnerType === 'organization' && !validOrganizationHandle)}
                onClick={() => void connectGitHub()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                <Code2 size={16} />
                Continue with GitHub
              </button>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        {installations.length > 0 && (
          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center gap-2">
              <Plus size={17} className="text-zinc-500" />
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Add a repository</h2>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                GitHub account
                <select
                  value={installationId ?? ''}
                  onChange={(event) => setInstallationId(Number(event.target.value) || null)}
                  className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                >
                  <option value="">Select installation</option>
                  {installations.map((installation) => (
                    <option key={installation.id} value={installation.id}>{installation.accountLogin}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Repository
                <select
                  value={repositoryId ?? ''}
                  onChange={(event) => setRepositoryId(Number(event.target.value) || null)}
                  disabled={!installationId || working}
                  className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                >
                  <option value="">Select repository</option>
                  {selectableRepositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>{repository.fullName}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!repositoryId || working}
                onClick={() => void addProject()}
                className="self-end rounded-lg border border-zinc-300 px-3.5 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                Add project
              </button>
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Projects</h2>
            <span className="text-xs text-zinc-500">{projects.length} connected</span>
          </div>
          {projects.length === 0 && !loading ? (
            <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              Connect GitHub to add a read-only project.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {projects.map((project) => (
                <article key={project.id} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a href={project.htmlUrl} target="_blank" rel="noreferrer" className="truncate font-semibold text-zinc-900 hover:underline dark:text-zinc-100">
                        {project.fullName}
                      </a>
                      <p className="mt-1 text-xs text-zinc-500">Default branch: {project.defaultBranch}</p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                      <LockKeyhole size={12} />
                      Read-only
                    </span>
                  </div>
                  <div className="mt-4 flex items-center gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                    <ShieldCheck size={14} />
                    No push, merge, executor, or deployment authority
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
