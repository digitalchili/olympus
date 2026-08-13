import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { BoardEvent, Task, TaskRunState } from '@shared/types';

function isActiveProjectRun(run: TaskRunState): boolean {
  return run.status === 'streaming' || run.status === 'compacting';
}

export function applyProjectBoardEvent(
  event: BoardEvent,
  setTasks: Dispatch<SetStateAction<Task[]>>,
  setTaskRuns: Dispatch<SetStateAction<Map<string, TaskRunState>>>,
): void {
  if (event.type === 'task_created' || event.type === 'task_updated') {
    setTasks((current) => {
      const index = current.findIndex((task) => task.id === event.task.id);
      if (index === -1) return [...current, event.task];
      const next = [...current];
      next[index] = event.task;
      return next;
    });
    return;
  }
  if (event.type === 'task_deleted') {
    setTasks((current) => current.filter((task) => task.id !== event.taskId));
    setTaskRuns((current) => {
      if (!current.has(event.taskId)) return current;
      const next = new Map(current);
      next.delete(event.taskId);
      return next;
    });
    return;
  }
  if (event.type === 'task_runs_snapshot') {
    setTaskRuns(new Map(event.runs.filter(isActiveProjectRun).map((run) => [run.taskId, run])));
    return;
  }
  if (event.type === 'task_run_updated') {
    setTaskRuns((current) => {
      const next = new Map(current);
      if (isActiveProjectRun(event.run)) next.set(event.run.taskId, event.run);
      else next.delete(event.run.taskId);
      return next;
    });
  }
}

export function useProjectBoardEvents(
  projectId: string,
  setTasks: Dispatch<SetStateAction<Task[]>>,
  reload: () => Promise<void>,
): Map<string, TaskRunState> {
  const [taskRuns, setTaskRuns] = useState<Map<string, TaskRunState>>(new Map());
  const retryRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
      source.onopen = () => {
        if (retryRef.current > 0) void reload();
        retryRef.current = 0;
      };
      source.onmessage = (message) => {
        try {
          applyProjectBoardEvent(JSON.parse(message.data) as BoardEvent, setTasks, setTaskRuns);
        } catch {
          // Ignore malformed or forward-compatible events; reconnect handles missed state.
        }
      };
      source.onerror = () => {
        source?.close();
        const delay = Math.min(1_000 * 2 ** retryRef.current, 30_000);
        retryRef.current += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [projectId, reload, setTasks]);

  return taskRuns;
}
