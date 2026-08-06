import { useEffect, useRef } from 'react';
import type { BoardEvent } from '@shared/types';
import { useStore } from '../lib/store';
import { fetchTasks } from '../lib/api';
import { playCompletionSound } from './useSoundOnComplete';
import { apiPathWithProfile } from '../lib/profileQuery';

export function useTasks() {
  const setTasks = useStore((s) => s.setTasks);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const setTaskRuns = useStore((s) => s.setTaskRuns);
  const setTaskRun = useStore((s) => s.setTaskRun);
  const setDelegationRuns = useStore((s) => s.setDelegationRuns);
  const setDelegationRun = useStore((s) => s.setDelegationRun);
  const retryRef = useRef(0);

  useEffect(() => {
    setTasks([]);
    setDelegationRuns([]);
    fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
  }, [setTasks, setDelegationRuns]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      es = new EventSource(`/api${apiPathWithProfile('/events')}`);

      es.onopen = () => {
        if (retryRef.current > 0) {
          fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
        }
        retryRef.current = 0;
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          if (event.type === 'task_created' || event.type === 'task_updated') {
            if (event.type === 'task_updated') {
              const prev = useStore.getState().tasks.find((t) => t.id === event.task.id);
              if (prev && prev.status === 'in_progress' && event.task.status === 'in_review') {
                playCompletionSound();
              }
            }
            upsertTask(event.task);
          } else if (event.type === 'task_deleted') {
            removeTask(event.taskId);
          } else if (event.type === 'task_runs_snapshot') {
            setTaskRuns(event.runs);
          } else if (event.type === 'task_run_updated') {
            setTaskRun(event.run);
          } else if (event.type === 'delegations_snapshot') {
            setDelegationRuns(event.runs);
          } else if (event.type === 'delegation_run_updated') {
            setDelegationRun(event.run);
          }
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current++;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, [setTasks, upsertTask, removeTask, setTaskRuns, setTaskRun, setDelegationRuns, setDelegationRun]);
}
