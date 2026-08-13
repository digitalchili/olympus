import { useCallback, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FolderKanban, Loader2, MoreHorizontal, Target } from 'lucide-react';
import { Link } from 'react-router';
import { ProfileLink, useProfile } from '../contexts/ProfileContext';
import { DEFAULT_PROFILE_NAME, type ProjectSummary, type Task, type TaskRunState, type TaskStatus } from '@shared/types';
import { goalTurnLabel, timeAgo } from '../lib/format';
import { isActiveRun } from '../lib/store';
import { hasUnseenAgentResponse } from '../lib/taskState';
import { taskProfileLabel } from '../lib/profiles';
import { TaskContextMenu } from './TaskContextMenu';
import { RenameTitle } from './RenameTitle';
import { toWithProfile } from '../lib/profileQuery';
import { projectChipClasses, projectTaskPath } from '../lib/projectTaskPresentation';

const BUSY_LABELS: Record<string, string> = { compact: 'Compacting...', goal: 'Working toward goal...' };

function TaskCardBody({ task, run }: { task: Task; run?: TaskRunState }) {
  const { profiles } = useProfile();
  const isUnseen = hasUnseenAgentResponse(task);
  const isBusy = !!run && isActiveRun(run);
  const isGoalRun = run?.kind === 'goal' && run.status === 'streaming';
  const compactGoalLabel = isGoalRun ? goalTurnLabel(run.goal?.turnsUsed ?? 0, run.goal?.maxTurns ?? 0, true) : null;
  const busyLabel = (run?.kind && BUSY_LABELS[run.kind]) || 'Working...';
  const showBusyState = isBusy && !isGoalRun;
  const routingLabel = taskProfileLabel(task, profiles);
  const timeRowClass = showBusyState
    ? 'font-semibold text-zinc-600 dark:text-zinc-300'
    : isUnseen
      ? 'font-semibold text-zinc-700 dark:text-zinc-200'
      : 'text-zinc-400 dark:text-zinc-500';

  return (
    <div>
      <RenameTitle
        value={task.title}
        identity={task.id}
        className={`block text-sm text-zinc-900 dark:text-zinc-100 line-clamp-2 ${
          isUnseen ? 'font-semibold' : 'font-medium'
        }`}
      />
      {task.description && (
        <p
          className={`mt-1 text-xs line-clamp-1 ${
            isUnseen
              ? 'text-zinc-600 dark:text-zinc-300'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {task.description}
        </p>
      )}
      <div className="mt-3 -mr-[18px] flex min-w-0 items-center gap-2">
        <div className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] leading-none ${timeRowClass}`}>
          {showBusyState ? (
            <Loader2 size={12} className="shrink-0 animate-spin" strokeWidth={2.5} />
          ) : isUnseen && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700 ring-4 ring-zinc-100 dark:bg-zinc-200 dark:ring-zinc-800" />
          )}
          <span className="truncate">{showBusyState ? busyLabel : timeAgo(task.updated_at)}</span>
        </div>
        {isGoalRun && (
          <span
            title={compactGoalLabel ? `Active goal run (${compactGoalLabel})` : 'Active goal run'}
            className="inline-flex h-5 max-w-[68%] shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] font-semibold leading-none text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-200"
          >
            <Target size={12} strokeWidth={2.5} className="shrink-0" />
            <span className="shrink-0">Goal active</span>
            {compactGoalLabel && (
              <span className="min-w-0 truncate font-medium text-zinc-500 dark:text-zinc-400">
                {compactGoalLabel}
              </span>
            )}
          </span>
        )}
      </div>
      {routingLabel && (
        <p className="mt-2 truncate text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
          {routingLabel}
        </p>
      )}
    </div>
  );
}

export function TaskCard({
  task,
  run,
  project,
  showLocation = false,
  onMoveTask,
  onDeleteTask,
}: {
  task: Task;
  run?: TaskRunState;
  project?: ProjectSummary;
  showLocation?: boolean;
  onMoveTask: (task: Task, status: TaskStatus) => Promise<void>;
  onDeleteTask: (task: Task) => Promise<void>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: task.id, data: { task } });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const isUnseen = hasUnseenAgentResponse(task);
  const isUnseenReview = isUnseen && task.status === 'in_review';

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleMenuButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu((current) => (
      current ? null : { x: rect.left, y: rect.bottom + 6 }
    ));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const stopPropagation = useCallback((e: { stopPropagation(): void }) => {
    e.stopPropagation();
  }, []);

  return (
    <>
      <div
        ref={setNodeRef}
        onContextMenu={handleContextMenu}
        className={`group/card relative rounded-lg border cursor-grab active:cursor-grabbing select-none transition-[background-color,opacity,box-shadow,border-color] duration-150 ${
          isUnseenReview ? 'bg-violet-50/80 dark:bg-violet-950/25' : 'bg-white dark:bg-zinc-900'
        } ${
          isDragging
            ? 'opacity-30 border-dashed border-zinc-300 dark:border-zinc-600 shadow-none'
            : isUnseenReview
              ? 'border-violet-200 dark:border-violet-800/70 shadow-md hover:shadow-lg hover:border-violet-300 dark:hover:border-violet-700'
              : isUnseen
                ? 'border-zinc-400 dark:border-zinc-600 shadow-lg hover:shadow-xl hover:border-zinc-400 dark:hover:border-zinc-500'
                : 'border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-md hover:border-zinc-300 dark:hover:border-zinc-700'
        }`}
      >
        <Link
          to={toWithProfile(projectTaskPath(task, project), task.handling_profile_id ?? task.profile_name ?? DEFAULT_PROFILE_NAME)}
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className={`block p-3.5 pr-8 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70 ${showLocation ? 'pb-2' : ''}`}
        >
          <TaskCardBody task={task} run={run} />
        </Link>
        {showLocation && project && (
          <div className="relative z-10 px-3.5 pb-3">
              <ProfileLink
                to={`/projects/${encodeURIComponent(project.id)}`}
                aria-label={`Project: ${project.name}`}
                onPointerDown={stopPropagation}
                onMouseDown={stopPropagation}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ${projectChipClasses(project.id)}`}
              >
                <FolderKanban size={12} className="shrink-0" />
                <span className="truncate">{project.name}</span>
              </ProfileLink>
          </div>
        )}
        <button
          type="button"
          onPointerDown={stopPropagation}
          onMouseDown={stopPropagation}
          onClick={handleMenuButtonClick}
          aria-label={`Actions for ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={contextMenu !== null}
          title="Task actions"
          className="absolute right-2 top-2 h-7 w-7 cursor-pointer inline-flex items-center justify-center rounded-md border border-transparent bg-white/85 text-zinc-400 hover:text-zinc-700 hover:border-zinc-200 hover:bg-white dark:bg-zinc-900/85 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70 transition-[background-color,border-color,color,opacity]"
        >
          <MoreHorizontal size={17} strokeWidth={2.5} />
        </button>
      </div>
      {contextMenu && (
        <TaskContextMenu
          task={task}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onMoveTask={onMoveTask}
          onDeleteTask={onDeleteTask}
        />
      )}
    </>
  );
}

export function TaskCardOverlay({ task, run, project, showLocation = false }: { task: Task; run?: TaskRunState; project?: ProjectSummary; showLocation?: boolean }) {
  return (
    <div className="p-3.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-600 shadow-2xl rotate-[2deg] scale-105 w-[280px] pointer-events-none">
      <TaskCardBody task={task} run={run} />
      {showLocation && project && <div className={`mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset ${projectChipClasses(project.id)}`}><FolderKanban size={12} />{project.name}</div>}
    </div>
  );
}
