import { Router } from 'express';
import type { createHermesUpdateService } from '../hermes-updates.js';

export function createHermesUpdatesRouter(service: ReturnType<typeof createHermesUpdateService>): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', async (req, res) => {
    try { res.json(await service.status(req.query.refresh === 'true')); }
    catch { res.status(503).json({ error: 'Hermes update status is unavailable.' }); }
  });
  router.post('/apply', async (req, res) => {
    try {
      if (req.get('X-Olympus-Update') !== '1' || ['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site') ?? '')) throw new Error('origin');
      const origin = req.get('origin');
      const host = req.get('x-forwarded-host')?.split(',', 1)[0]?.trim() || req.get('host');
      const protocol = req.get('x-forwarded-proto')?.split(',', 1)[0]?.trim() || req.protocol;
      if (origin && new URL(origin).origin !== new URL(`${protocol}://${host}`).origin) throw new Error('origin');
    } catch { return res.status(403).json({ error: 'Start the update from Olympus Settings.' }); }
    try {
      const result = await service.apply(req.body?.targetRevision, req.body?.targetOlympusVersion);
      if (!result) return res.status(409).json({ error: 'This update is no longer available. Refresh its status before trying again.' });
      return res.status(202).json(result);
    } catch { return res.status(502).json({ error: 'The updater could not confirm the request. Check its status before trying again.' }); }
  });
  return router;
}
