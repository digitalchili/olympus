import { Router } from 'express';
import {
  LocalProfileError,
  localProfileRegistry,
  readProfileSettings,
  updateProfileSettings,
} from '../local-profiles.js';

const profilesRouter = Router();

profilesRouter.get('/', (_req, res) => {
  res.json({ profiles: localProfileRegistry.publicProfiles() });
});

profilesRouter.get('/:id/settings', async (req, res) => {
  try {
    res.json({ settings: await readProfileSettings(localProfileRegistry.require(req.params.id)) });
  } catch (error) {
    if (error instanceof LocalProfileError) return res.status(error.status).json({ error: error.message, code: error.code });
    res.status(500).json({ error: 'Could not read profile settings', code: 'PROFILE_SETTINGS_ERROR' });
  }
});

profilesRouter.patch('/:id/settings', async (req, res) => {
  try {
    const settings = await updateProfileSettings(localProfileRegistry.require(req.params.id), req.body);
    res.json({ settings });
  } catch (error) {
    if (error instanceof LocalProfileError) return res.status(error.status).json({ error: error.message, code: error.code });
    res.status(500).json({ error: 'Could not update profile settings', code: 'PROFILE_SETTINGS_ERROR' });
  }
});

profilesRouter.post('/', (_req, res) => {
  res.status(405).json({ error: 'Hermes profiles are managed in the local Hermes installation.' });
});

profilesRouter.delete('/:name', (_req, res) => {
  res.status(405).json({ error: 'Hermes profiles are managed in the local Hermes installation.' });
});

export { profilesRouter };
