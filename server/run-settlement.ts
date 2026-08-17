import type { LiveChatMessage, LiveChatRunStatus } from '../shared/types.js';

export function hasReviewableAssistantOutput(messages: LiveChatMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' && (
    message.content.trim().length > 0
    || (message.thinking?.trim().length ?? 0) > 0
    || (message.tools?.length ?? 0) > 0
  ));
}

export function shouldPromoteTerminalRun(status: LiveChatRunStatus, hasAssistantOutput: boolean): boolean {
  if (status === 'done') return true;
  return (status === 'error' || status === 'stopped') && hasAssistantOutput;
}