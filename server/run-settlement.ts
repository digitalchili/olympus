import type { LiveChatRunStatus } from '../shared/types.js';

export function shouldPromoteTerminalRun(status: LiveChatRunStatus): boolean {
  return status === 'done';
}