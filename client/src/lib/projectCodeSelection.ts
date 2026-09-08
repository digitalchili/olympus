import type { PublicProjectEditorLease, Task } from '@shared/types';

export function selectProjectCodeTask(current: string, tasks: Pick<Task, 'id' | 'status'>[], editors: PublicProjectEditorLease[]): string {
  if (tasks.some(task => task.id === current)) return current;
  return editors.find(editor => tasks.some(task => task.id === editor.taskId))?.taskId
    ?? tasks.find(task => task.status === 'in_progress')?.id
    ?? tasks[0]?.id
    ?? '';
}

export function projectTaskCodeView<V extends { taskId: string | null }, S extends { taskId: string }>(
  taskId: string, editors: PublicProjectEditorLease[], versions: V[], status: S | null,
) {
  return {
    editor: editors.find(editor => editor.taskId === taskId) ?? null,
    versions: versions.filter(version => version.taskId === taskId),
    status: status?.taskId === taskId ? status : null,
  };
}
