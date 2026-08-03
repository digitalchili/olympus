import { Router } from 'express';
import { remoteProfileRegistry } from '../remote-profiles.js';

const profilesRouter = Router();

profilesRouter.get('/', (_req, res) => {
  res.json({ profiles: remoteProfileRegistry.publicProfiles() });
});

profilesRouter.post('/', (_req, res) => {
  res.status(405).json({ error: 'Remote profiles are configured on the server, not created from Olympus Dispatch.' });
});

profilesRouter.delete('/:name', (_req, res) => {
  res.status(405).json({ error: 'Remote profiles are configured on the server, not deleted from Olympus Dispatch.' });
});

export { profilesRouter };
