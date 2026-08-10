import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileText, GitBranch, Pencil, Plus, Save, Shield, Trash2, X } from 'lucide-react';
import { Link, useParams } from 'react-router';
import type {
  ProjectAccessRole,
  ProjectManagerHistoryEntry,
  ProjectProfileGrant,
  ProjectSummary,
  Task,
  TaskStatus,
} from '@shared/types';
import {
  deleteTask,
  fetchProject,
  fetchProjectGrants,
  fetchProjectTasks,
  moveTask,
  reassignProjectManager,
  revokeProjectGrant,
  setProjectGrant,
  updateProject,
} from '../lib/api';
import { useProfile } from '../contexts/ProfileContext';
import { toWithProfile } from '../lib/profileQuery';
import { toErrorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import { TaskKanban } from './Board';

const accessRoles: ProjectAccessRole[] = ['view', 'contribute', 'manage'];

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const { profiles } = useProfile();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [history, setHistory] = useState<ProjectManagerHistoryEntry[]>([]);
  const [grants, setGrants] = useState<ProjectProfileGrant[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextManager, setNextManager] = useState('');
  const [previousManagerRole, setPreviousManagerRole] = useState<'view' | 'contribute' | 'none'>('none');
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftPurpose, setDraftPurpose] = useState('');
  const [grantProfileId, setGrantProfileId] = useState('');
  const [grantRole, setGrantRole] = useState<ProjectAccessRole>('view');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const taskRuns = useStore((state) => state.taskRuns);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [detail, taskResult, grantResult] = await Promise.all([
        fetchProject(projectId),
        fetchProjectTasks(projectId),
        fetchProjectGrants(projectId),
      ]);
      setProject(detail.project);
      setHistory(detail.managerHistory);
      setTasks(taskResult.tasks);
      setGrants(grantResult.grants);
      setNextManager(detail.project.managerProfileId);
      setDraftName(detail.project.name);
      setDraftPurpose(detail.project.purpose);
    } catch (cause) {
      setLoadError(toErrorMessage(cause, 'Could not load Project'));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const eligibleGrantProfiles = useMemo(
    () => profiles.filter((profile) => profile.active && profile.id !== project?.managerProfileId),
    [profiles, project?.managerProfileId],
  );

  const profileName = (profileId: string) => (
    profiles.find((profile) => profile.id === profileId)?.displayName ?? profileId
  );

  const saveProject = async () => {
    if (!project || !draftName.trim() || !draftPurpose.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await updateProject(project.id, { name: draftName, purpose: draftPurpose });
      setProject(result.project);
      setDraftName(result.project.name);
      setDraftPurpose(result.project.purpose);
      setEditing(false);
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not update Project'));
    } finally {
      setBusy(false);
    }
  };

  const changeManager = async () => {
    if (!project || !nextManager || nextManager === project.managerProfileId) return;
    setBusy(true);
    setActionError(null);
    try {
      await reassignProjectManager(
        project.id,
        nextManager,
        previousManagerRole === 'none' ? null : previousManagerRole,
      );
      setPreviousManagerRole('none');
      setGrantProfileId('');
      await load();
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not change manager'));
    } finally {
      setBusy(false);
    }
  };

  const saveGrant = async () => {
    if (!project || !grantProfileId) return;
    setBusy(true);
    setActionError(null);
    try {
      await setProjectGrant(project.id, grantProfileId, grantRole);
      const result = await fetchProjectGrants(project.id);
      setGrants(result.grants);
      setGrantProfileId('');
      setGrantRole('view');
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not update Project access'));
    } finally {
      setBusy(false);
    }
  };

  const removeGrant = async (profileId: string) => {
    if (!project) return;
    setBusy(true);
    setActionError(null);
    try {
      await revokeProjectGrant(project.id, profileId);
      setGrants((current) => current.filter((grant) => grant.profileId !== profileId));
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not revoke Project access'));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="p-7 text-sm text-red-600">{loadError}</div>;
  if (!project) return <div className="p-7 text-sm text-zinc-500">Loading Project…</div>;

  const taskProfileId = (task: Task) => task.handling_profile_id ?? task.profile_name ?? project.managerProfileId;

  const moveProjectTask = async (task: Task, status: TaskStatus): Promise<Task> => {
    const result = await moveTask(task.id, status, taskProfileId(task));
    setTasks((current) => current.map((item) => item.id === task.id ? result.task : item));
    return result.task;
  };

  const deleteProjectTask = async (task: Task) => {
    await deleteTask(task.id, taskProfileId(task));
    setTasks((current) => current.filter((item) => item.id !== task.id));
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 sm:p-7">
      <div className="mx-auto max-w-[1600px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Project</p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{project.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{project.purpose}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setEditing((value) => !value)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3.5 text-sm font-medium dark:border-zinc-700">
              <Pencil size={15} /> Edit Project
            </button>
            <Link to={toWithProfile({ pathname: '/tasks/new', search: `?project=${encodeURIComponent(project.id)}` }, project.managerProfileId)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"><Plus size={16} /> New task</Link>
          </div>
        </div>

        {editing && (
          <section className="mt-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] sm:items-end">
              <label className="text-xs font-medium text-zinc-500">Name<input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={120} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700" /></label>
              <label className="text-xs font-medium text-zinc-500">Purpose<textarea value={draftPurpose} onChange={(event) => setDraftPurpose(event.target.value)} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm dark:border-zinc-700" /></label>
              <div className="flex gap-2">
                <button type="button" disabled={busy || !draftName.trim() || !draftPurpose.trim()} onClick={() => void saveProject()} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"><Save size={14} /> Save</button>
                <button type="button" onClick={() => setEditing(false)} className="inline-flex h-9 items-center rounded-lg border border-zinc-200 px-3 dark:border-zinc-700"><X size={14} /></button>
              </div>
            </div>
          </section>
        )}

        {actionError && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">{actionError}</div>}

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <main className="min-w-0">
            <TaskKanban tasks={tasks} taskRuns={taskRuns} createTaskTo={toWithProfile({ pathname: '/tasks/new', search: `?project=${encodeURIComponent(project.id)}` }, project.managerProfileId)} onMoveTask={moveProjectTask} onDeleteTask={deleteProjectTask} className="flex min-h-[420px] gap-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-4 sm:gap-6 dark:border-zinc-800 dark:bg-zinc-900" />
          </main>

          <aside className="space-y-4">
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Managed by</h2>
              <p className="mt-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">{project.manager.displayName}</p>
              <p className="mt-1 text-xs text-zinc-500">{[project.manager.provider, project.manager.model].filter(Boolean).join(' · ') || 'Profile defaults'}</p>
              <label className="mt-3 block text-[11px] font-medium text-zinc-500">New manager<select value={nextManager} onChange={(event) => setNextManager(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 text-sm dark:border-zinc-700">{profiles.filter((profile) => profile.active).map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
              {nextManager !== project.managerProfileId && <label className="mt-2 block text-[11px] font-medium text-zinc-500">Previous manager keeps<select value={previousManagerRole} onChange={(event) => setPreviousManagerRole(event.target.value as typeof previousManagerRole)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 text-sm dark:border-zinc-700"><option value="none">No access</option><option value="view">View</option><option value="contribute">Contribute</option></select></label>}
              <button disabled={busy || nextManager === project.managerProfileId} onClick={() => void changeManager()} className="mt-2 h-8 w-full rounded-lg border border-zinc-200 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Change manager</button>
              <p className="mt-2 text-[11px] leading-4 text-zinc-400">Future tasks only. Active tasks keep their immutable handler unless explicitly transferred.</p>
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="flex items-center gap-2 text-sm font-medium"><Shield size={15} /> Project access</h2>
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-xs"><span className="truncate font-medium">{project.manager.displayName}</span><span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500 dark:bg-zinc-800">manage · manager</span></div>
                {grants.map((grant) => <div key={grant.profileId} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{profileName(grant.profileId)}</span><span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500 dark:bg-zinc-800">{grant.role}</span><button type="button" aria-label={`Revoke ${profileName(grant.profileId)}`} disabled={busy} onClick={() => void removeGrant(grant.profileId)} className="text-zinc-400 hover:text-red-600"><Trash2 size={13} /></button></div>)}
              </div>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <select aria-label="Profile access" value={grantProfileId} onChange={(event) => setGrantProfileId(event.target.value)} className="h-8 min-w-0 rounded-lg border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"><option value="">Choose profile</option>{eligibleGrantProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select>
                <select aria-label="Access role" value={grantRole} onChange={(event) => setGrantRole(event.target.value as ProjectAccessRole)} className="h-8 rounded-lg border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700">{accessRoles.map((role) => <option key={role} value={role}>{role}</option>)}</select>
              </div>
              <button type="button" disabled={busy || !grantProfileId} onClick={() => void saveGrant()} className="mt-2 h-8 w-full rounded-lg border border-zinc-200 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Add or update access</button>
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="flex items-center gap-2 text-sm font-medium"><FileText size={15} /> References</h2><p className="mt-2 text-xs text-zinc-500">Document ingestion arrives in the next verified slice.</p></section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="flex items-center gap-2 text-sm font-medium"><GitBranch size={15} /> Repository</h2><p className="mt-2 text-xs text-zinc-500">No repository selected.</p><Link to="/settings" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">GitHub setup <ExternalLink size={12} /></Link></section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Manager history</h2><div className="mt-2 space-y-2">{history.map((entry) => <div key={entry.id} className="text-xs text-zinc-500"><span className="font-medium text-zinc-700 dark:text-zinc-300">{profileName(entry.profileId)}</span><br />{new Date(entry.effectiveFrom).toLocaleString()}{entry.effectiveTo ? ` – ${new Date(entry.effectiveTo).toLocaleString()}` : ' – current'}</div>)}</div></section>
          </aside>
        </div>
      </div>
    </div>
  );
}
