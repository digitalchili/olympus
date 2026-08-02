import { Router } from 'express';
import db from '../db/index.js';
import { isRecord } from '../errors.js';

const INSTALLATION_NAME_KEY = 'installation_name';
const DEFAULT_INSTALLATION_NAME = 'Hermes';
const MAX_NAME_LENGTH = 80;

function getInstallationName(): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(INSTALLATION_NAME_KEY) as { value?: string } | undefined;
  return row?.value?.trim() || DEFAULT_INSTALLATION_NAME;
}

function setInstallationName(name: string): string {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(INSTALLATION_NAME_KEY, name, Date.now());
  return name;
}

export function createInstallationRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ name: getInstallationName() });
  });

  router.patch('/', (req, res) => {
    if (!isRecord(req.body) || typeof req.body.name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }

    const name = req.body.name.trim() || DEFAULT_INSTALLATION_NAME;
    if (name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer` });
    }

    res.json({ name: setInstallationName(name) });
  });

  return router;
}
