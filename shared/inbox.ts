import type { NativeInteraction } from './interactions.js';
import type { TaskMessage } from './types.js';

export type InboxCategory = 'questions' | 'review' | 'help';

export interface InboxItem {
  key: string;
  taskId: string;
  title: string;
  profileId: string;
  profileName: string;
  projectId: string | null;
  projectName: string | null;
  category: InboxCategory;
  summary: string;
  actionLabel: string;
  updatedAt: number;
  interactionId: string | null;
}

export interface InboxSnapshot {
  items: InboxItem[];
}

export interface InboxPreview {
  item: InboxItem;
  interaction?: NativeInteraction;
  reply?: Pick<TaskMessage, 'content' | 'created_at'>;
  historyUnavailable?: boolean;
}

export function inboxTaskUrl(item: Pick<InboxItem, 'taskId' | 'profileId' | 'projectId'>): string {
  const task = `/tasks/${encodeURIComponent(item.taskId)}`;
  return `${item.projectId ? `/projects/${encodeURIComponent(item.projectId)}` : ''}${task}?profile=${encodeURIComponent(item.profileId)}`;
}
