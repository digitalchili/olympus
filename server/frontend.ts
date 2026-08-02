import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const CLIENT_DIST_DIR = path.join(CLIENT_DIR, 'dist');
const CLIENT_INDEX = path.join(CLIENT_DIST_DIR, 'index.html');

export type FrontendCleanup = () => Promise<void> | void;

export async function mountFrontend(app: Express, httpServer: Server): Promise<FrontendCleanup> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.join(CLIENT_DIR, 'vite.config.ts'),
      root: CLIENT_DIR,
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    });

    app.use(vite.middlewares);
    return () => vite.close();
  }

  if (!existsSync(CLIENT_INDEX)) {
    throw new Error(`Client build not found at ${CLIENT_INDEX}. Run npm run build first.`);
  }

  app.use(express.static(CLIENT_DIST_DIR));
  app.get('*', (_req, res) => {
    res.sendFile(CLIENT_INDEX);
  });
  return () => {};
}
