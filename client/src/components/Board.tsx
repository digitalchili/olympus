import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { AlertTriangle, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { To } from 'react-router';
import { ProfileLink, useProfile } from '../contexts/ProfileContext';
import type { ScheduledTask, Task, TaskRunState, TaskStatus } from '@shared/types';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { useStore } from '../lib/store';
import { deleteTask, fetchScheduledTasks, moveTask } from '../lib/api';
import { buildScheduledTaskFixDraft } from '../lib/scheduledTaskFix';
import { relativeTime } from '../lib/schedule';
import { toWithProfile } from '../lib/profileQuery';
import { Column } from './Column';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { TaskCardOverlay } from './TaskCard';

const dropAnimation = {
  duration: 200,
  easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
};

function scheduledTaskRunsPath(scheduledTaskId: string): string {
  return `/scheduled-tasks/${scheduledTaskId}/runs`;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function scheduledTaskNeedsAttention(scheduledTask: ScheduledTask): boolean {
  if (!scheduledTask.enabled) return false;
  return (
    scheduledTask.lastStatus === 'error'
    || Boolean(scheduledTask.lastError || scheduledTask.lastDeliveryError)
  );
}

function scheduledTaskAttentionReason(scheduledTask: ScheduledTask): string {
  if (scheduledTask.lastStatus === 'error' || scheduledTask.lastError) return 'failed';
  if (scheduledTask.lastDeliveryError) return 'had a delivery issue';
  return 'needs attention';
}

function RecurringSummaryStrip({ scheduledTasks }: { scheduledTasks: ScheduledTask[] }) {
  const attentionTasks = scheduledTasks
    .filter(scheduledTaskNeedsAttention)
    .sort((a, b) => (timestamp(b.lastRunAt) ?? 0) - (timestamp(a.lastRunAt) ?? 0));

  if (attentionTasks.length === 0) return null;

  const attentionTask = attentionTasks[0];
  const attentionReason = scheduledTaskAttentionReason(attentionTask);
  const summary = `${attentionTasks.length} need${attentionTasks.length === 1 ? 's' : ''} attention: ${attentionTask.name} ${attentionReason}${attentionTask.lastRunAt ? ` ${relativeTime(attentionTask.lastRunAt)}` : ''}`;

  return (
    <div className="mx-3 mt-3 flex min-h-11 items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 sm:mx-6 sm:mt-4 sm:px-3.5 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertTriangle size={14} strokeWidth={2.4} />
        </span>
        <span className="shrink-0 font-semibold text-zinc-900 dark:text-zinc-100">Recurring</span>
        <span className="min-w-0 truncate">{summary}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ProfileLink
          to="/tasks/new"
          state={{ draft: buildScheduledTaskFixDraft(attentionTask) }}
          className="inline-flex items-center gap-1 rounded-md bg-rose-700 px-2 py-1 font-semibold text-white transition-colors hover:bg-rose-800 dark:bg-rose-300 dark:text-rose-950 dark:hover:bg-rose-200"
        >
          <Wrench size={13} />
          Fix it
        </ProfileLink>
        <ProfileLink
          to={scheduledTaskRunsPath(attentionTask.id)}
          className="rounded-md px-2 py-1 font-semibold text-rose-800 transition-colors hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-950/40"
        >
          Review →
        </ProfileLink>
      </div>
    </div>
  );
}

interface TaskKanbanProps {
  tasks: Task[];
  taskRuns: Map<string, TaskRunState>;
  createTaskTo: To;
  onMoveTask: (task: Task, status: TaskStatus) => Promise<Task>;
  onDeleteTask: (task: Task) => Promise<void>;
  className?: string;
}

export function TaskKanban({
  tasks,
  taskRuns,
  createTaskTo,
  onMoveTask,
  onDeleteTask,
  className = 'flex flex-1 gap-4 overflow-x-auto p-3 min-h-0 sm:gap-6 sm:p-6',
}: TaskKanbanProps) {
  const [visibleTasks, setVisibleTasks] = useState(tasks);
  const grouped = useMemo(() => {
    const buckets: Record<TaskStatus, Task[]> = { in_progress: [], in_review: [], done: [] };
    for (const task of visibleTasks) {
      if (task.status in buckets) buckets[task.status].push(task);
    }
    for (const status of TASK_STATUSES) buckets[status].sort((a, b) => b.updated_at - a.updated_at);
    return buckets;
  }, [visibleTasks]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteAllStatus, setDeleteAllStatus] = useState<TaskStatus | null>(null);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  useEffect(() => setVisibleTasks(tasks), [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    const task = (event.active.data.current as { task: Task } | undefined)?.task ?? null;
    setActiveTask(task);
  }

  async function handleMoveTask(task: Task, status: TaskStatus) {
    if (task.status === status) return;
    const optimistic = { ...task, status, updated_at: Date.now() };
    setVisibleTasks((current) => current.map((item) => item.id === task.id ? optimistic : item));
    try {
      const updated = await onMoveTask(task, status);
      setVisibleTasks((current) => current.map((item) => item.id === task.id ? updated : item));
    } catch {
      setVisibleTasks((current) => current.map((item) => item.id === task.id ? task : item));
    }
  }

  async function handleDeleteTask(task: Task) {
    await onDeleteTask(task);
    setVisibleTasks((current) => current.filter((item) => item.id !== task.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const targetStatus = over.id as TaskStatus;
    const task = (active.data.current as { task: Task })?.task;
    if (!task || task.status === targetStatus) return;

    await handleMoveTask(task, targetStatus);
  }

  function handleRequestDeleteAll(status: TaskStatus) {
    setBulkDeleteError(null);
    setDeleteAllStatus(status);
  }

  function handleCancelDeleteAll() {
    if (isBulkDeleting) return;
    setDeleteAllStatus(null);
    setBulkDeleteError(null);
  }

  async function handleConfirmDeleteAll() {
    if (!deleteAllStatus || isBulkDeleting) return;

    const targets = grouped[deleteAllStatus];
    if (targets.length === 0) {
      handleCancelDeleteAll();
      return;
    }

    setIsBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      const results = await Promise.allSettled(targets.map(handleDeleteTask));
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed === 0) {
        setDeleteAllStatus(null);
      } else {
        setBulkDeleteError(`Failed to delete ${failed} task${failed === 1 ? '' : 's'}.`);
      }
    } finally {
      setIsBulkDeleting(false);
    }
  }

  const deleteAllTasks = deleteAllStatus ? grouped[deleteAllStatus] : [];
  const deleteAllLabel = deleteAllStatus ? STATUS_META[deleteAllStatus].label : '';
  const deleteAllCount = deleteAllTasks.length;
  const deleteAllTaskWord = deleteAllCount === 1 ? 'task' : 'tasks';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className={className}>
        {TASK_STATUSES.map((status, index) => (
          <Column
            key={status}
            status={status}
            tasks={grouped[status]}
            taskRuns={taskRuns}
            isLast={index === TASK_STATUSES.length - 1}
            onRequestDeleteAll={handleRequestDeleteAll}
            createTaskTo={createTaskTo}
            onMoveTask={handleMoveTask}
            onDeleteTask={handleDeleteTask}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask && (
          <TaskCardOverlay
            task={activeTask}
            run={taskRuns.get(activeTask.id)}
          />
        )}
      </DragOverlay>
      {deleteAllStatus && (
        <DeleteConfirmModal
          title={`Delete ${deleteAllCount} ${deleteAllLabel} ${deleteAllTaskWord}?`}
          body={
            deleteAllCount === 1
              ? `This removes the task in ${deleteAllLabel} from Olympus Dispatch. The Hermes session history remains in Hermes.`
              : `This removes every task in ${deleteAllLabel} from Olympus Dispatch. Hermes session histories remain in Hermes.`
          }
          confirmLabel={deleteAllCount === 1 ? 'Delete task' : `Delete ${deleteAllCount} tasks`}
          isConfirming={isBulkDeleting}
          error={bulkDeleteError}
          onConfirm={handleConfirmDeleteAll}
          onCancel={handleCancelDeleteAll}
        />
      )}
    </DndContext>
  );
}

export function Board() {
  const tasks = useStore((state) => state.tasks);
  const taskRuns = useStore((state) => state.taskRuns);
  const upsertTask = useStore((state) => state.upsertTask);
  const removeTask = useStore((state) => state.removeTask);
  const { activeProfileId } = useProfile();
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetchScheduledTasks(true)
      .then((result) => { if (!cancelled) setScheduledTasks(result.scheduledTasks); })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleMoveTask(task: Task, status: TaskStatus): Promise<Task> {
    const profileId = task.handling_profile_id ?? task.profile_name ?? activeProfileId;
    const result = await moveTask(task.id, status, profileId);
    upsertTask(result.task);
    return result.task;
  }

  async function handleDeleteTask(task: Task) {
    const profileId = task.handling_profile_id ?? task.profile_name ?? activeProfileId;
    await deleteTask(task.id, profileId);
    removeTask(task.id);
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <RecurringSummaryStrip scheduledTasks={scheduledTasks} />
      <TaskKanban
        tasks={tasks}
        taskRuns={taskRuns}
        createTaskTo={toWithProfile('/tasks/new', activeProfileId)}
        onMoveTask={handleMoveTask}
        onDeleteTask={handleDeleteTask}
      />
    </div>
  );
}
