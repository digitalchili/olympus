import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { DrainController } from './drain.js';

export function isMaintenanceAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(supplied, expected);
}

export function createDrainRouter(
  controller: DrainController,
  token = process.env.OLYMPUS_MAINTENANCE_TOKEN,
  onIdle?: () => void,
  hermes?: { check: () => Promise<unknown>; fenced: () => boolean },
): Router {
  const router = Router();
  let drainGeneration = 0;
  router.use((req, res, next) => {
    if (!isMaintenanceAuthorized(req.headers.authorization, token)) {
      res.status(401).json({ error: 'Valid maintenance authentication is required.', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  });
  router.get('/status', async (_req, res) => res.json(await controller.refreshStatus()));
  if (hermes) router.get('/hermes/check', async (_req, res) => {
    try { res.json(await hermes.check()); }
    catch { res.status(503).json({ ready: false, blockers: ['Hermes verification is unavailable.'] }); }
  });
  router.post('/drain', async (_req, res) => {
    const changed = controller.begin();
    if (changed && onIdle) {
      const generation = ++drainGeneration;
      void controller.waitForIdle(24 * 60 * 60_000).then((idle) => {
        if (idle && generation === drainGeneration && controller.status().draining) onIdle();
      });
    }
    res.json({ changed, ...await controller.refreshStatus() });
  });
  router.post('/cancel', async (_req, res) => {
    if (hermes?.fenced()) return res.status(409).json({ error: 'The Hermes update must be verified or recovered before work resumes.' });
    const changed = controller.cancel();
    if (changed) drainGeneration += 1;
    res.json({ changed, ...await controller.refreshStatus() });
  });
  return router;
}

export function maintenanceGuard(controller: DrainController): RequestHandler {
  return (req, res, next) => {
    if (!controller.status().draining || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    res.setHeader('Retry-After', '5');
    res.status(503).json({
      error: 'Olympus Dispatch is finishing active work for an update. Retry shortly.',
      code: 'MAINTENANCE_DRAIN',
      retryable: true,
    });
  };
}
