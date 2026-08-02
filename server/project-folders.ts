import { realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { resolveMinionsWorkspaceDir } from './paths.js';

function configuredRoot(): string {
  const candidate = process.env.OLYMPUS_DISPATCH_PROJECT_ROOT?.trim() || join(homedir(), 'Dev');
  return existsSync(candidate) ? resolve(candidate) : resolveMinionsWorkspaceDir();
}

const PROJECT_ROOT = configuredRoot();

function isInsideRoot(target: string): boolean {
  const rel = relative(PROJECT_ROOT, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveProjectDirectory(value?: unknown): Promise<string> {
  const requested = typeof value === 'string' && value.trim() ? value : PROJECT_ROOT;
  const target = resolve(requested);
  if (!isInsideRoot(target)) throw new Error(`Project folder must be inside ${PROJECT_ROOT}`);

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new Error('Project folder does not exist');
  }
  if (!isInsideRoot(real)) throw new Error(`Project folder must be inside ${PROJECT_ROOT}`);
  return real;
}

export async function validateProjectWorkdir(value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null;
  return resolveProjectDirectory(value);
}

export const projectFoldersRouter = Router();

projectFoldersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const path = await resolveProjectDirectory(req.query.path);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path, { withFileTypes: true });
    const directories = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const candidate = join(path, entry.name);
        try {
          const resolved = await resolveProjectDirectory(candidate);
          return { name: basename(resolved), path: resolved };
        } catch {
          return null;
        }
      }));

    res.json({
      root: PROJECT_ROOT,
      path,
      parentPath: path === PROJECT_ROOT ? null : resolve(path, '..'),
      directories: directories.filter((entry): entry is { name: string; path: string } => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to list project folders' });
  }
});
