import { Router } from 'express';
import type { HermesChannel } from '../../shared/types.js';
import { discoverHermesChannels } from '../hermes-channels.js';
import { requestProfile, sendProfileError } from '../profile-context.js';

type ChannelDiscovery = (hermesHome: string) => Promise<HermesChannel[]>;

export function createChannelsRouter(discover: ChannelDiscovery = discoverHermesChannels): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const profile = requestProfile(req);
      res.json({ channels: await discover(profile.hermesHome) });
    } catch (error) {
      const profileError = sendProfileError(error);
      if (profileError) return res.status(profileError.status).json(profileError.body);
      return res.status(500).json({ error: 'Could not read Hermes channel status', code: 'CHANNEL_DISCOVERY_ERROR' });
    }
  });

  return router;
}
