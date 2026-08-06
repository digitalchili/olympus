import { create } from 'zustand';
import type { DelegationRun, Task, TaskRunState, TaskStatus } from '@shared/types';
import { applyDelegationRunUpdate } from './delegationActivity';

interface AppState {
  tasks: Task[];
  taskRuns: Map<string, TaskRunState>;
  delegationRuns: Map<string, DelegationRun[]>;
  tasksLoaded: boolean;
  sidebarCollapsed: boolean;
  installationName: string;

  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setTaskRuns: (runs: TaskRunState[]) => void;
  setTaskRun: (run: TaskRunState) => void;
  setDelegationRuns: (runs: DelegationRun[]) => void;
  setDelegationRun: (run: DelegationRun) => void;
  toggleSidebar: () => void;
  setInstallationName: (name: string) => void;
}

function tasksEqual(a: Task, b: Task): boolean {
  return a.updated_at === b.updated_at && a.last_viewed_at === b.last_viewed_at;
}

export function isActiveRun(run: TaskRunState): boolean {
  return run.status === 'streaming' || run.status === 'compacting';
}

function taskRunEqual(a: TaskRunState | undefined, b: TaskRunState): boolean {
  if (!a) return false;
  return (
    a.runId === b.runId &&
    a.status === b.status &&
    a.kind === b.kind &&
    a.goal?.turnsUsed === b.goal?.turnsUsed &&
    a.goal?.maxTurns === b.goal?.maxTurns &&
    a.goal?.status === b.goal?.status
  );
}

export const useStore = create<AppState>((set) => ({
  tasks: [],
  taskRuns: new Map<string, TaskRunState>(),
  delegationRuns: new Map<string, DelegationRun[]>(),
  tasksLoaded: false,
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
  installationName: 'Hermes',

  setTasks: (tasks) => set({ tasks, tasksLoaded: true }),

  upsertTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...state.tasks, task] };
      const existing = state.tasks[idx];
      if (tasksEqual(existing, task)) return state;
      const next = [...state.tasks];
      next[idx] = task;
      return { tasks: next };
    }),

  removeTask: (taskId) =>
    set((state) => {
      const tasks = state.tasks.filter((t) => t.id !== taskId);
      if (!state.taskRuns.has(taskId) && !state.delegationRuns.has(taskId)) return { tasks };
      const taskRuns = new Map(state.taskRuns);
      taskRuns.delete(taskId);
      const delegationRuns = new Map(state.delegationRuns);
      delegationRuns.delete(taskId);
      return { tasks, taskRuns, delegationRuns };
    }),

  setTaskRuns: (runs) =>
    set((state) => {
      const activeRuns = runs.filter(isActiveRun);
      if (
        activeRuns.length === state.taskRuns.size &&
        activeRuns.every((run) => taskRunEqual(state.taskRuns.get(run.taskId), run))
      ) {
        return state;
      }
      return { taskRuns: new Map(activeRuns.map((run) => [run.taskId, run])) };
    }),

  setTaskRun: (run) =>
    set((state) => {
      const current = state.taskRuns.get(run.taskId);
      const shouldStore = isActiveRun(run);
      if (
        (!shouldStore && !current) ||
        (shouldStore && taskRunEqual(current, run))
      ) {
        return state;
      }

      const taskRuns = new Map(state.taskRuns);
      if (shouldStore) taskRuns.set(run.taskId, run);
      else taskRuns.delete(run.taskId);
      return { taskRuns };
    }),

  setDelegationRuns: (runs) =>
    set(() => {
      const grouped = new Map<string, DelegationRun[]>();
      for (const run of runs) {
        grouped.set(run.task_id, [...(grouped.get(run.task_id) ?? []), run]);
      }
      return { delegationRuns: grouped };
    }),

  setDelegationRun: (run) =>
    set((state) => {
      const current = state.delegationRuns.get(run.task_id) ?? [];
      const next = applyDelegationRunUpdate(current, run);
      if (next === current) return state;
      const delegationRuns = new Map(state.delegationRuns);
      delegationRuns.set(run.task_id, next);
      return { delegationRuns };
    }),

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      localStorage.setItem('sidebarCollapsed', String(next));
      return { sidebarCollapsed: next };
    }),

  setInstallationName: (installationName) => set({ installationName }),
}));

export async function optimisticMoveTask(
  task: Task,
  status: TaskStatus,
  upsertTask: (t: Task) => void,
  apiMove: (id: string, s: TaskStatus) => Promise<{ task: Task }>,
) {
  upsertTask({ ...task, status, updated_at: Date.now() });
  try {
    const res = await apiMove(task.id, status);
    upsertTask(res.task);
  } catch {
    upsertTask(task);
  }
}
