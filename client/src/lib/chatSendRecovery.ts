export type ChatSendFailure = {
  ok: false;
  error: string;
  conflict?: boolean;
  code?: string;
  activeTaskId?: string;
  activeTaskTitle?: string;
  activeTaskProfileId?: string;
  reason?: 'changes' | 'editor';
};
export type SendMessageResult = { ok: true; runId?: string } | ChatSendFailure;
export type ProjectChatBlocker = ChatSendFailure;

export function chatSendFailure(status: number, body: unknown): ChatSendFailure {
  const details = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const failure: ChatSendFailure = { ok: false, conflict: status === 409, error: typeof details.error === 'string' && details.error ? details.error : `HTTP ${status}` };
  for (const key of ['code', 'activeTaskId', 'activeTaskTitle', 'activeTaskProfileId'] as const) {
    if (typeof details[key] === 'string') failure[key] = details[key];
  }
  if (details.reason === 'changes' || details.reason === 'editor') failure.reason = details.reason;
  return failure;
}

export function settleProjectChatBlocker(previous: ProjectChatBlocker | null, currentTaskId: string | null, responseTaskId: string, result: SendMessageResult): ProjectChatBlocker | null {
  if (currentTaskId !== responseTaskId) return previous;
  if (result.ok) return null;
  return result.code === 'PROJECT_REPOSITORY_BUSY' ? result : previous;
}

export function restoreRejectedChatDraft(args: {
  currentTaskId: string;
  responseTaskId: string;
  revisionAtSend: number;
  currentRevision: number;
  currentDraft: string;
  sentContent: string;
}): string {
  if (args.currentTaskId !== args.responseTaskId || args.currentRevision !== args.revisionAtSend || args.currentDraft) return args.currentDraft;
  return args.sentContent;
}
