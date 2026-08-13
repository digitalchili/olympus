import { useEffect, useState } from 'react';
import { ArrowRight, FolderKanban, GitBranch, Plus, X } from 'lucide-react';
import type { ProjectSummary, StudioGitHubInstallation, StudioGitHubRepository } from '@shared/types';
import { createProject, fetchProjects, fetchStudioGitHubStatus, fetchStudioRepositories } from '../lib/api';
import { ProfileLink, useProfile } from '../contexts/ProfileContext';
import { toErrorMessage } from '../lib/format';
import { selectableStudioRepositories } from '../lib/studio-projects';

export function ProjectsPage() {
  const { profiles } = useProfile();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [managerProfileId, setManagerProfileId] = useState('');
  const [saving, setSaving] = useState(false);
  const [installations, setInstallations] = useState<StudioGitHubInstallation[]>([]);
  const [repositories, setRepositories] = useState<StudioGitHubRepository[]>([]);
  const [repositoryInstallationId, setRepositoryInstallationId] = useState<number | null>(null);
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStudioGitHubStatus()
      .then(({ installations: next }) => {
        const writable = next.filter((installation) => installation.permissionMode === 'read_write');
        setInstallations(writable);
        if (writable.length === 1) setRepositoryInstallationId(writable[0].id);
      })
      .catch(() => undefined);
    fetchProjects()
      .then(({ projects: next }) => setProjects(next))
      .catch((cause) => setError(toErrorMessage(cause, 'Could not load Projects')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!managerProfileId) {
      const firstActive = profiles.find((profile) => profile.active);
      if (firstActive) setManagerProfileId(firstActive.id);
    }
  }, [managerProfileId, profiles]);


  useEffect(() => {
    if (!repositoryInstallationId) {
      setRepositories([]);
      setRepositoryId(null);
      return;
    }
    let cancelled = false;
    fetchStudioRepositories(repositoryInstallationId)
      .then(({ repositories: next }) => {
        if (!cancelled) {
          setRepositories(next);
          const selectable = selectableStudioRepositories(next, projects.map((project) => project.repositoryLink).filter((link) => link !== null && link !== undefined));
          setRepositoryId((current) => current && selectable.some((repo) => repo.id === current) ? current : selectable[0]?.id ?? null);
        }
      })
      .catch(() => { if (!cancelled) setRepositories([]); });
    return () => { cancelled = true; };
  }, [repositoryInstallationId, projects]);

  const selectableRepositories = selectableStudioRepositories(
    repositories,
    projects.map((project) => project.repositoryLink).filter((link) => link !== null && link !== undefined),
  );

  const submit = async () => {
    if (!name.trim() || !purpose.trim() || !managerProfileId) return;
    setSaving(true);
    setError(null);
    try {
      const { project } = await createProject({
        name: name.trim(),
        purpose: purpose.trim(),
        managerProfileId,
        repositoryLink: repositoryInstallationId && repositoryId ? { installationId: repositoryInstallationId, repositoryId } : null,
      });
      setProjects((current) => [project, ...current]);
      setName('');
      setPurpose('');
      setRepositoryId(null);
      setShowCreate(false);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not create Project'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 sm:p-7">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Projects</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Durable workspaces with their own manager, tasks, references, and repository.
            </p>
          </div>
          <button onClick={() => setShowCreate(true)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
            <Plus size={16} /> New Project
          </button>
        </div>

        {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}

        {showCreate && (
          <section className="mt-5 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-zinc-900 dark:text-zinc-100">New Project</h2>
              <button aria-label="Close" onClick={() => setShowCreate(false)} className="text-zinc-400 hover:text-zinc-700"><X size={18} /></button>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Name
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="mt-1.5 h-10 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700" placeholder="Project name" />
              </label>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Managed by
                <select value={managerProfileId} onChange={(event) => setManagerProfileId(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700">
                  {profiles.filter((profile) => profile.active).map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
                </select>
              </label>

              {installations.length > 0 && (
                <>
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">GitHub connection (optional)
                    <select value={repositoryInstallationId ?? ''} onChange={(event) => setRepositoryInstallationId(Number(event.target.value) || null)} className="mt-1.5 h-10 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700">
                      <option value="">No repository</option>
                      {installations.map((installation) => <option key={installation.id} value={installation.id}>{installation.label}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Repository
                    <select value={repositoryId ?? ''} disabled={!repositoryInstallationId} onChange={(event) => setRepositoryId(Number(event.target.value) || null)} className="mt-1.5 h-10 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm disabled:opacity-50 dark:border-zinc-700">
                      <option value="">No repository</option>
                      {selectableRepositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="sm:col-span-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">Purpose
                <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={2000} rows={3} className="mt-1.5 w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm dark:border-zinc-700" placeholder="What this Project exists to accomplish" />
              </label>
            </div>
            <div className="mt-4 flex justify-end"><button disabled={saving || !name.trim() || !purpose.trim() || !managerProfileId} onClick={submit} className="h-9 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{saving ? 'Creating…' : 'Create Project'}</button></div>
          </section>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {loading ? <p className="text-sm text-zinc-500">Loading Projects…</p> : projects.map((project) => (
            <ProfileLink key={project.id} to={`/projects/${project.id}`} className="group rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3"><span className="rounded-lg bg-zinc-100 p-2 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"><FolderKanban size={18} /></span><h2 className="truncate font-medium text-zinc-900 dark:text-zinc-100">{project.name}</h2></div>
                <ArrowRight size={16} className="mt-2 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-600" />
              </div>
              <p className="mt-3 line-clamp-2 text-sm leading-5 text-zinc-500 dark:text-zinc-400">{project.purpose}</p>
              <div className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Managed by</span> {project.manager.displayName}
                {(project.manager.provider || project.manager.model) && <span className="ml-1 text-zinc-400">· {[project.manager.provider, project.manager.model].filter(Boolean).join(' · ')}</span>}
                {project.repositoryLink && <span className="mt-1 flex items-center gap-1 text-zinc-500"><GitBranch size={12} /> {project.repositoryLink.fullName} · protected branch</span>}
              </div>
            </ProfileLink>
          ))}
        </div>
        {!loading && projects.length === 0 && <div className="mt-12 text-center text-sm text-zinc-500">No Projects yet. Inbox tasks remain available without one.</div>}
      </div>
    </div>
  );
}
