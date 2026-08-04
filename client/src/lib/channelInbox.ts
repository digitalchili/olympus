import {
  isHermesMessageChannelId,
  type HermesChannel,
  type HermesChannelMessage,
  type HermesChannelMessagesResult,
  type HermesChannelThreadsResult,
} from '@shared/types';

export function pinnedChannelInboxes(channels: HermesChannel[]): HermesChannel[] {
  return channels.filter((channel) => channel.enabled && isHermesMessageChannelId(channel.id));
}

export function channelThreadsStatusText(result: HermesChannelThreadsResult): string | null {
  if (result.state === 'awaiting_bridge') return 'Local Hermes history is not available yet.';
  return result.threads.length === 0 ? 'No local conversations yet.' : null;
}

export function channelMessagesStatusText(result: HermesChannelMessagesResult): string | null {
  if (result.state === 'awaiting_bridge') return 'Local Hermes history is not available yet.';
  return result.messages.length === 0 ? 'No visible user or assistant messages in this conversation.' : null;
}

export function channelMessageAuthor(direction: HermesChannelMessage['direction']): 'User' | 'Assistant' {
  return direction === 'inbound' ? 'User' : 'Assistant';
}
