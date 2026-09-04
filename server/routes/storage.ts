import { Router } from 'express';
import { statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  resolveHermesHome,
  resolveOlympusDbPath,
  resolveOlympusHome,
  resolveProjectRoot,
} from '../paths.js';
import type { StorageStatus } from '../../shared/types.js';

export function createStorageRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const olympusHome = resolveOlympusHome();
    let disk: StorageStatus['disk'] = null;

    try {
      const stats = await statfs(olympusHome);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
      disk = {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent,
      };
    } catch {
      // statfs may fail in restricted virtual environments
    }

    const isDocker = existsSync('/.dockerenv') || Boolean(process.env.HERMES_WRITE_SAFE_ROOT);

    const status: StorageStatus = {
      olympusHome,
      hermesHome: resolveHermesHome(),
      projectRoot: resolveProjectRoot(),
      dbPath: resolveOlympusDbPath(),
      isDocker,
      disk,
    };

    res.json(status);
  });

  router.post('/probe/local', async (req, res) => {
    const targetPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const { testLocalPathProbe } = await import('../storage-probe.js');
    const result = await testLocalPathProbe(targetPath);
    res.json(result);
  });

  router.post('/probe/ssh', async (req, res) => {
    const { testSshStorageProbe } = await import('../storage-probe.js');
    const host = typeof req.body?.host === 'string' ? req.body.host : '';
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const port = typeof req.body?.port === 'number' ? req.body.port : 22;
    const remotePath = typeof req.body?.remotePath === 'string' ? req.body.remotePath : '';
    const privateKey = typeof req.body?.privateKey === 'string' ? req.body.privateKey : undefined;

    const result = await testSshStorageProbe({
      host,
      username,
      port,
      remotePath,
      privateKey,
    });
    res.json(result);
  });

  return router;
}
