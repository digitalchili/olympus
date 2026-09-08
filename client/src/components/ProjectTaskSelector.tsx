import type { Task } from '@shared/types';

export function ProjectTaskSelector({ tasks, selectedTaskId, disabled, onSelect, canRelease, onRelease }: { tasks: Pick<Task, 'id' | 'title'>[]; selectedTaskId: string; disabled: boolean; onSelect: (taskId: string) => void; canRelease?: boolean; onRelease?: () => void }) {
  return <><select aria-label="Task changes" value={selectedTaskId} disabled={disabled} onChange={event => onSelect(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 text-sm disabled:opacity-40 dark:border-zinc-700">
    <option value="">Choose a task</option>
    {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
  </select>{onRelease && <button type="button" onClick={onRelease} disabled={disabled || !canRelease} title="Saved files remain available when you reopen this task." className="h-9 rounded-lg border border-zinc-200 px-3 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Release workspace</button>}</>;
}
