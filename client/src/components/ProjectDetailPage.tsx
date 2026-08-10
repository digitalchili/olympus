import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, FileText, GitBranch, Plus } from 'lucide-react';
import { Link, useParams } from 'react-router';
import type { ProjectManagerHistoryEntry, ProjectSummary, Task, TaskStatus } from '@shared/types';
import { deleteTask, fetchProject, fetchProjectTasks, moveTask, reassignProjectManager } from '../lib/api';
import { useProfile } from '../contexts/ProfileContext';
import { toWithProfile } from '../lib/profileQuery';
import { toErrorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import { TaskKanban } from './Board';

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const { profiles } = useProfile();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [history, setHistory] = useState<ProjectManagerHistoryEntry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextManager, setNextManager] = useState('');
  const [error, setError] = useState<string | null>(null);
  const taskRuns = useStore((state) => state.taskRuns);

  const load = useCallback(async () => {
    try {
      const [detail, taskResult] = await Promise.all([fetchProject(projectId), fetchProjectTasks(projectId)]);
      setProject(detail.project);
      setHistory(detail.managerHistory);
      setTasks(taskResult.tasks);
      setNextManager(detail.project.managerProfileId);
    } catch (cause) { setError(toErrorMessage(cause, 'Could not load Project')); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="p-7 text-sm text-red-600">{error}</div>;
  if (!project) return <div className="p-7 text-sm text-zinc-500">Loading Project…</div>;

  const changeManager = async () => {
    if (!nextManager || nextManager === project.managerProfileId) return;
    try {
      await reassignProjectManager(project.id, nextManager, null);
      await load();
    } catch (cause) { setError(toErrorMessage(cause, 'Could not change manager')); }
  };

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
          <div><p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Project</p><h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{project.name}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{project.purpose}</p></div>
          <Link to={toWithProfile({ pathname: '/tasks/new', search: `?project=${encodeURIComponent(project.id)}` }, project.managerProfileId)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"><Plus size={16} /> New task</Link>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <main className="min-w-0">
            <TaskKanban
              tasks={tasks}
              taskRuns={taskRuns}
              createTaskTo={toWithProfile({ pathname: '/tasks/new', search: `?project=${encodeURIComponent(project.id)}` }, project.managerProfileId)}
              onMoveTask={moveProjectTask}
              onDeleteTask={deleteProjectTask}
              className="flex min-h-[420px] gap-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-4 sm:gap-6 dark:border-zinc-800 dark:bg-zinc-900"
            />
          </main>

          <aside className="space-y-4">
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Managed by</h2>
              <p className="mt-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">{project.manager.displayName}</p>
              <p className="mt-1 text-xs text-zinc-500">{[project.manager.provider, project.manager.model].filter(Boolean).join(' · ') || 'Profile defaults'}</p>
              <select value={nextManager} onChange={(event) => setNextManager(event.target.value)} className="mt-3 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 text-sm dark:border-zinc-700">{profiles.filter((profile) => profile.active).map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select>
              <button disabled={nextManager === project.managerProfileId} onClick={changeManager} className="mt-2 h-8 w-full rounded-lg border border-zinc-200 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Change manager</button>
              <p className="mt-2 text-[11px] leading-4 text-zinc-400">Future tasks only. Active tasks keep their handler.</p>
            </section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="flex items-center gap-2 text-sm font-medium"><FileText size={15} /> References</h2><p className="mt-2 text-xs text-zinc-500">Document ingestion arrives in the next verified slice.</p></section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="flex items-center gap-2 text-sm font-medium"><GitBranch size={15} /> Repository</h2><p className="mt-2 text-xs text-zinc-500">No repository selected.</p><Link to="/studio" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">GitHub setup <ExternalLink size={12} /></Link></section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Manager history</h2><div className="mt-2 space-y-2">{history.map((entry) => <div key={entry.id} className="text-xs text-zinc-500"><span className="font-medium text-zinc-700 dark:text-zinc-300">{entry.profileId}</span><br />{new Date(entry.effectiveFrom).toLocaleString()}</div>)}</div></section>
          </aside>
        </div>
      </div>
    </div>
  );
}
