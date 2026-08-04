import { Router } from 'express';
import type { HermesChannel } from '../../shared/types.js';
import { isHermesMessageChannelId } from '../../shared/types.js';
import db from '../db/index.js';
import {
  ChannelHistoryBridge,
  HermesSqliteChannelHistorySource,
  type ChannelHistorySource,
} from '../channel-history.js';
import { discoverHermesChannels } from '../hermes-channels.js';
import { localProfileRegistry, type LocalProfileRegistry } from '../local-profiles.js';
import { requestProfile, sendProfileError } from '../profile-context.js';

type DispatchDb = import('better-sqlite3').Database;
type ChannelDiscovery = (hermesHome: string) => Promise<HermesChannel[]>;

interface ChannelHistoryRouterDependencies {
  db?: DispatchDb;
  source?: ChannelHistorySource;
  discover?: ChannelDiscovery;
  profiles?: LocalProfileRegistry;
}

export function createChannelHistoryRouter({
  db: dispatchDb = db,
  source = new HermesSqliteChannelHistorySource(),
  discover = discoverHermesChannels,
  profiles = localProfileRegistry,
}: ChannelHistoryRouterDependencies = {}): Router {
  const router = Router();

  async function isKnownChannel(hermesHome: string, channelId: string): Promise<boolean> {
    if (!isHermesMessageChannelId(channelId)) return false;
    return (await discover(hermesHome)).some((channel) => channel.id === channelId);
  }

  router.get('/:channelId/threads', async (req, res) => {
    try {
      const profile = requestProfile(req, profiles);
      const channelId = req.params.channelId;
      if (!await isKnownChannel(profile.hermesHome, channelId)) {
        return res.status(404).json({ error: 'Channel not found', code: 'CHANNEL_NOT_FOUND' });
      }

      const bridge = new ChannelHistoryBridge(dispatchDb, source);
      return res.json(await bridge.listThreads(profile.id, profile.hermesHome, channelId));
    } catch (error) {
      const profileError = sendProfileError(error);
      if (profileError) return res.status(profileError.status).json(profileError.body);
      return res.status(500).json({ error: 'Could not read local Hermes channel history', code: 'CHANNEL_HISTORY_ERROR' });
    }
  });

  router.get('/:channelId/threads/:threadId/messages', async (req, res) => {
    try {
      const profile = requestProfile(req, profiles);
      const channelId = req.params.channelId;
      if (!await isKnownChannel(profile.hermesHome, channelId)) {
        return res.status(404).json({ error: 'Channel not found', code: 'CHANNEL_NOT_FOUND' });
      }

      const bridge = new ChannelHistoryBridge(dispatchDb, source);
      const result = await bridge.listMessages(profile.id, profile.hermesHome, channelId, req.params.threadId);
      if (!result) return res.status(404).json({ error: 'Conversation not found', code: 'CHANNEL_THREAD_NOT_FOUND' });
      return res.json(result);
    } catch (error) {
      const profileError = sendProfileError(error);
      if (profileError) return res.status(profileError.status).json(profileError.body);
      return res.status(500).json({ error: 'Could not read local Hermes channel messages', code: 'CHANNEL_HISTORY_ERROR' });
    }
  });

  return router;
}
