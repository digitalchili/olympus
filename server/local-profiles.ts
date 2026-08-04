import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type {
  HermesProfile,
  HermesProfileSettings,
  ReasoningEffort,
  TaskRoutingSource,
} from '../shared/types.js';
import { DEFAULT_PROFILE_NAME, REASONING_EFFORTS } from '../shared/types.js';
import { resolveHermesHome, resolveMinionsWorkspaceDir } from './paths.js';

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const DISPLAY_KEYS = ['display_name', 'displayName', 'name', 'label'] as const;
const MAX_DISPLAY_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_MODEL_VALUE = 200;
const MAX_SOUL_BYTES = 256 * 1024;

export interface LocalProfileTarget extends HermesProfile {
  hermesHome: string;
  workspaceDir: string;
  skillsDir: string;
  scheduledOutputDir: string;
}

export class LocalProfileError extends Error {
  constructor(public status: number, message: string, public code = 'LOCAL_PROFILE_ERROR') {
    super(message);
    this.name = 'LocalProfileError';
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readYamlRecord(path: string, optional = false): Record<string, unknown> {
  try {
    const parsed = parse(readFileSync(path, 'utf8')) as unknown;
    const result = recordValue(parsed);
    if (!result) throw new Error('YAML root must be a mapping');
    return result;
  } catch (error) {
    if (optional && !existsSync(path)) return {};
    throw error;
  }
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function metadataDisplayName(metadata: Record<string, unknown>, fallback: string): string {
  for (const key of DISPLAY_KEYS) {
    const value = cleanString(metadata[key]);
    if (value) return value;
  }
  return fallback;
}

function profileCapabilities(hermesHome: string): HermesProfile['capabilities'] {
  return {
    settings: existsSync(join(hermesHome, 'config.yaml')),
    soul: existsSync(join(hermesHome, 'SOUL.md')),
    workspace: existsSync(join(hermesHome, 'workspace')),
    skills: existsSync(join(hermesHome, 'skills')),
    scheduledTasks: existsSync(join(hermesHome, 'cron')),
  };
}

function profileHealth(hermesHome: string): HermesProfile['health'] {
  const issues: string[] = [];
  try {
    const config = statSync(join(hermesHome, 'config.yaml'));
    if (!config.isFile()) issues.push('Configuration is unavailable');
    else readYamlRecord(join(hermesHome, 'config.yaml'));
  } catch {
    issues.push('Configuration could not be read');
  }
  try {
    if (!statSync(hermesHome).isDirectory()) issues.push('Profile directory is unavailable');
  } catch {
    issues.push('Profile directory is unavailable');
  }
  return { status: issues.length === 0 ? 'ready' : 'degraded', issues };
}

function buildTarget(id: string, hermesHome: string, isDefault: boolean, metadata: Record<string, unknown>): LocalProfileTarget {
  const fallbackLabel = isDefault ? 'Default' : id;
  return {
    id,
    label: metadataDisplayName(metadata, fallbackLabel),
    description: cleanString(metadata.description),
    isDefault,
    capabilities: profileCapabilities(hermesHome),
    health: profileHealth(hermesHome),
    hermesHome,
    workspaceDir: isDefault ? resolveMinionsWorkspaceDir() : join(hermesHome, 'workspace'),
    skillsDir: join(hermesHome, 'skills'),
    scheduledOutputDir: join(hermesHome, 'cron', 'output'),
  };
}

function defaultProfile(hermesHome: string): LocalProfileTarget {
  let metadata: Record<string, unknown> = {};
  try { metadata = readYamlRecord(join(hermesHome, 'profile.yaml'), true); } catch { /* health reports invalid config only */ }
  return buildTarget(DEFAULT_PROFILE_NAME, hermesHome, true, metadata);
}

function readNamedProfile(profilesHome: string, name: string): LocalProfileTarget | null {
  if (name === DEFAULT_PROFILE_NAME || !PROFILE_ID_PATTERN.test(name)) return null;
  const hermesHome = join(profilesHome, name);

  try {
    const metadata = readYamlRecord(join(hermesHome, 'profile.yaml'));
    return buildTarget(name, hermesHome, false, metadata);
  } catch {
    return null;
  }
}

export function discoverLocalProfileTargets(hermesHome = resolveHermesHome()): LocalProfileTarget[] {
  const targets = [defaultProfile(hermesHome)];
  const profilesHome = join(hermesHome, 'profiles');

  try {
    const entries = readdirSync(profilesHome, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = readNamedProfile(profilesHome, entry.name);
      if (target) targets.push(target);
    }
  } catch {
    // The profiles directory is optional. The root profile always exists logically.
  }

  return targets;
}

export function discoverLocalProfiles(hermesHome = resolveHermesHome()): HermesProfile[] {
  return discoverLocalProfileTargets(hermesHome).map(({ hermesHome: _home, workspaceDir: _workspace, skillsDir: _skills, scheduledOutputDir: _cron, ...profile }) => profile);
}

export class LocalProfileRegistry {
  constructor(private hermesHome = resolveHermesHome()) {}

  publicProfiles(): HermesProfile[] {
    return discoverLocalProfiles(this.hermesHome);
  }

  default(): LocalProfileTarget {
    return discoverLocalProfileTargets(this.hermesHome)[0];
  }

  get(id: string | null | undefined): LocalProfileTarget | null {
    if (!id) return null;
    return discoverLocalProfileTargets(this.hermesHome).find((profile) => profile.id === id) ?? null;
  }

  require(id: string): LocalProfileTarget {
    const target = this.get(id);
    if (!target) throw new LocalProfileError(400, `Unknown local Hermes profile: ${id}`, 'UNKNOWN_PROFILE');
    return target;
  }
}

export const localProfileRegistry = new LocalProfileRegistry();

export function resolveTaskProfile(
  registry: LocalProfileRegistry,
  input: { requestedProfileName?: unknown },
): { profileName: string | null; routingSource: TaskRoutingSource | null } {
  if (input.requestedProfileName === undefined || input.requestedProfileName === null || input.requestedProfileName === '') {
    return { profileName: null, routingSource: null };
  }
  if (typeof input.requestedProfileName !== 'string') {
    throw new LocalProfileError(400, 'Local Hermes profile name must be a string');
  }

  const requested = input.requestedProfileName.trim();
  if (!requested) return { profileName: null, routingSource: null };
  return { profileName: registry.require(requested).id, routingSource: 'manual' };
}

function nestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = recordValue(parent[key]);
  if (current) return current;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function optionalConfigString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function readProfileSettings(target: LocalProfileTarget): Promise<HermesProfileSettings> {
  const metadataPath = join(target.hermesHome, 'profile.yaml');
  const configPath = join(target.hermesHome, 'config.yaml');
  const soulPath = join(target.hermesHome, 'SOUL.md');
  const [metadataText, configText, soul] = await Promise.all([
    readFile(metadataPath, 'utf8').catch(() => ''),
    readFile(configPath, 'utf8').catch(() => ''),
    readFile(soulPath, 'utf8').catch(() => ''),
  ]);
  const metadata = metadataText ? recordValue(parse(metadataText)) ?? {} : {};
  const config = configText ? recordValue(parse(configText)) ?? {} : {};
  const model = recordValue(config.model) ?? {};
  const agent = recordValue(config.agent) ?? {};
  const rawReasoning = optionalConfigString(agent.reasoning_effort);
  const reasoningEffort = rawReasoning && (REASONING_EFFORTS as readonly string[]).includes(rawReasoning)
    ? rawReasoning as ReasoningEffort
    : null;

  return {
    id: target.id,
    displayName: metadataDisplayName(metadata, target.isDefault ? 'Default' : target.id),
    description: cleanString(metadata.description),
    model: optionalConfigString(model.default),
    provider: optionalConfigString(model.provider),
    reasoningEffort,
    soul,
  };
}

function validatedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new LocalProfileError(400, `${field} must be a string`, 'INVALID_PROFILE_SETTINGS');
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new LocalProfileError(400, `${field} is too long`, 'INVALID_PROFILE_SETTINGS');
  if (/\p{Cc}/u.test(trimmed)) throw new LocalProfileError(400, `${field} contains invalid control characters`, 'INVALID_PROFILE_SETTINGS');
  return trimmed;
}

function validatedOptionalSetting(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  return validatedText(value, field, MAX_MODEL_VALUE);
}

async function atomicWriteWithBackup(target: LocalProfileTarget, fileName: string, content: string): Promise<void> {
  const path = join(target.hermesHome, fileName);
  const backupDir = join(target.hermesHome, '.olympus-dispatch-backups');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const temp = join(target.hermesHome, `.${basename(fileName)}.${randomUUID()}.tmp`);
  await mkdir(target.hermesHome, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  if (existsSync(path)) await copyFile(path, join(backupDir, `${timestamp}-${basename(fileName)}`));
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function updateProfileSettings(target: LocalProfileTarget, value: unknown): Promise<HermesProfileSettings> {
  const updates = recordValue(value);
  if (!updates) throw new LocalProfileError(400, 'Request body is required', 'INVALID_PROFILE_SETTINGS');
  const allowed = new Set(['displayName', 'description', 'model', 'provider', 'reasoningEffort', 'soul']);
  const unknown = Object.keys(updates).filter((key) => !allowed.has(key));
  if (unknown.length) throw new LocalProfileError(400, `Unsupported profile setting: ${unknown[0]}`, 'INVALID_PROFILE_SETTINGS');

  const metadataPath = join(target.hermesHome, 'profile.yaml');
  const configPath = join(target.hermesHome, 'config.yaml');
  const metadata = existsSync(metadataPath) ? readYamlRecord(metadataPath) : {};
  const config = existsSync(configPath) ? readYamlRecord(configPath) : {};
  const changedFiles: string[] = [];

  if ('displayName' in updates || 'description' in updates) {
    if ('displayName' in updates) {
      const displayName = validatedText(updates.displayName, 'displayName', MAX_DISPLAY_NAME);
      const existingKey = DISPLAY_KEYS.find((key) => Object.prototype.hasOwnProperty.call(metadata, key));
      for (const key of DISPLAY_KEYS) delete metadata[key];
      metadata[existingKey ?? 'display_name'] = displayName;
    }
    if ('description' in updates) metadata.description = validatedText(updates.description, 'description', MAX_DESCRIPTION);
    await atomicWriteWithBackup(target, 'profile.yaml', stringify(metadata));
    changedFiles.push('profile.yaml');
  }

  if ('model' in updates || 'provider' in updates || 'reasoningEffort' in updates) {
    const modelConfig = nestedRecord(config, 'model');
    const agentConfig = nestedRecord(config, 'agent');
    if ('model' in updates) modelConfig.default = validatedOptionalSetting(updates.model, 'model');
    if ('provider' in updates) modelConfig.provider = validatedOptionalSetting(updates.provider, 'provider');
    if ('reasoningEffort' in updates) {
      const effort = updates.reasoningEffort;
      if (effort !== null && (typeof effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(effort))) {
        throw new LocalProfileError(400, `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}`, 'INVALID_PROFILE_SETTINGS');
      }
      agentConfig.reasoning_effort = effort;
    }
    await atomicWriteWithBackup(target, 'config.yaml', stringify(config));
    changedFiles.push('config.yaml');
  }

  if ('soul' in updates) {
    if (typeof updates.soul !== 'string') throw new LocalProfileError(400, 'soul must be a string', 'INVALID_PROFILE_SETTINGS');
    if (Buffer.byteLength(updates.soul, 'utf8') > MAX_SOUL_BYTES) throw new LocalProfileError(413, 'soul is too large', 'INVALID_PROFILE_SETTINGS');
    await atomicWriteWithBackup(target, 'SOUL.md', updates.soul);
    changedFiles.push('SOUL.md');
  }

  if (changedFiles.length > 0) {
    const audit = {
      at: new Date().toISOString(),
      action: 'profile.settings.updated',
      fields: Object.keys(updates).sort(),
      files: changedFiles,
    };
    await appendFile(join(target.hermesHome, '.olympus-dispatch-audit.jsonl'), `${JSON.stringify(audit)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  return readProfileSettings(target);
}
