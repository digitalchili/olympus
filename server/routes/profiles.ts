import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Router, type Response } from 'express';
import YAML from 'yaml';
import { resolveHermesHome } from '../paths.js';

const execFileAsync = promisify(execFile);
const profilesRouter = Router();
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_LENGTH = 240;

class ProfileRouteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface HermesProfileSummary {
  name: string;
  active: boolean;
  description: string;
  model: string | null;
  provider: string | null;
  skillCount: number;
  skills: string[];
  hasSoul: boolean;
  soulPreview: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseYamlObject(content: string): Record<string, unknown> {
  try {
    const value = YAML.parse(content);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSkills(dir: string): Promise<string[]> {
  if (!await exists(dir)) return [];
  const skills: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        await walk(path);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        skills.push(current.slice(dir.length + 1).split('\\').join('/'));
      }
    }
  };
  await walk(dir);
  return skills.sort((a, b) => a.localeCompare(b));
}

async function profileSummary(name: string, directory: string, active: boolean): Promise<HermesProfileSummary> {
  const configPath = join(directory, 'config.yaml');
  const profilePath = join(directory, 'profile.yaml');
  const soulPath = join(directory, 'SOUL.md');
  const [configText, profileText, soulText] = await Promise.all([
    readFile(configPath, 'utf8').catch(() => ''),
    readFile(profilePath, 'utf8').catch(() => ''),
    readFile(soulPath, 'utf8').catch(() => ''),
  ]);
  const config = parseYamlObject(configText);
  const profile = parseYamlObject(profileText);
  const model = isRecord(config.model) ? config.model : {};
  const cleanedSoul = soulText.replace(/\s+/g, ' ').trim();
  const skills = await findSkills(join(directory, 'skills'));

  return {
    name,
    active,
    description: stringValue(profile.description) ?? '',
    model: stringValue(model.default),
    provider: stringValue(model.provider),
    skillCount: skills.length,
    skills,
    hasSoul: cleanedSoul.length > 0,
    soulPreview: cleanedSoul ? cleanedSoul.slice(0, 220) : null,
  };
}

async function listProfiles(): Promise<HermesProfileSummary[]> {
  const home = resolveHermesHome();
  const profilesDir = join(home, 'profiles');
  const activeName = process.env.HERMES_PROFILE?.trim() || 'default';
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const names = ['default', ...entries.filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name)).map((entry) => entry.name)];
  return Promise.all(names.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))).map((name) => (
    profileSummary(name, name === 'default' ? home : join(profilesDir, name), name === activeName)
  )));
}

function profileName(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_NAME.test(value)) {
    throw new ProfileRouteError(400, 'Profile names use lowercase letters, numbers, and hyphens only.');
  }
  return value;
}

function description(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ProfileRouteError(400, 'Profile description must be text.');
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) throw new ProfileRouteError(400, `Profile description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`);
  return trimmed || null;
}

async function runHermesProfile(args: string[]): Promise<void> {
  const bin = process.env.HERMES_BIN?.trim() || 'hermes';
  await execFileAsync(bin, args, {
    cwd: homedir(),
    env: process.env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ProfileRouteError) {
    res.status(error.status).json({ error: error.message, code: 'PROFILES_ERROR' });
    return;
  }
  const message = error instanceof Error ? error.message : 'Profile operation failed.';
  console.error('Profile operation failed', error);
  res.status(500).json({ error: message, code: 'PROFILES_ERROR' });
}

profilesRouter.get('/', async (_req, res) => {
  try {
    res.json({ profiles: await listProfiles() });
  } catch (error) {
    sendError(res, error);
  }
});

profilesRouter.post('/', async (req, res) => {
  try {
    const name = profileName(req.body?.name);
    if (name === 'default') throw new ProfileRouteError(400, 'The default profile already exists.');
    const existing = await listProfiles();
    if (existing.some((profile) => profile.name === name)) throw new ProfileRouteError(409, 'A profile with that name already exists.');
    const args = ['profile', 'create', name, '--no-alias'];
    const profileDescription = description(req.body?.description);
    if (profileDescription) args.push('--description', profileDescription);
    await runHermesProfile(args);
    const profile = (await listProfiles()).find((item) => item.name === name);
    if (!profile) throw new Error('Hermes created the profile but it could not be read back.');
    res.status(201).json({ profile });
  } catch (error) {
    sendError(res, error);
  }
});

profilesRouter.delete('/:name', async (req, res) => {
  try {
    const name = profileName(req.params.name);
    const activeName = process.env.HERMES_PROFILE?.trim() || 'default';
    if (name === 'default' || name === activeName) {
      throw new ProfileRouteError(400, 'The default or active profile cannot be deleted from Olympus.');
    }
    const existing = await listProfiles();
    if (!existing.some((profile) => profile.name === name)) throw new ProfileRouteError(404, 'Profile not found.');
    await runHermesProfile(['profile', 'delete', '-y', name]);
    res.json({ ok: true, name });
  } catch (error) {
    sendError(res, error);
  }
});

export { profilesRouter };
