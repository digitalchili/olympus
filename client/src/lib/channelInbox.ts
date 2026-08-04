import { isHermesMessageChannelId, type HermesChannel } from '@shared/types';

export function pinnedChannelInboxes(channels: HermesChannel[]): HermesChannel[] {
  return channels.filter((channel) => channel.enabled && isHermesMessageChannelId(channel.id));
}
