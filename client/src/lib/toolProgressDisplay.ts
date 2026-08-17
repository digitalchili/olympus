import type { ToolProgressEvent } from '@shared/types';

export function visibleToolProgress(tools: ToolProgressEvent[]): ToolProgressEvent[] {
  return tools.length > 0 ? [tools[tools.length - 1]] : [];
}
