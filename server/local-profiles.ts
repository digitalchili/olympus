import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type {
  HermesProfile,
  HermesProfileCreateInput,
  HermesProfileSettings,
  ReasoningEffort,
  TaskRoutingSource,
} from '../shared/types.js';
import { DEFAULT_PROFILE_NAME, REASONING_EFFORTS } from '../shared/types.js';
import {
  resolveHermesHome,
  resolveMinionsBackupsDir,
  resolveMinionsHome,
  resolveMinionsLogsDir,
  resolveMinionsWorkspaceDir,
} from './paths.js';

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DISPLAY_KEYS = ['displayName', 'display_name', 'name', 'label'] as const;
const MAX_PROFILE_ID = 64;
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
  const displayName = metadataDisplayName(metadata, fallbackLabel);
  return {
    id,
    displayName,
    label: displayName,
    description: cleanString(metadata.description),
    active: isDefault || metadata.active !== false,
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
  try { metadata = readYamlRecord(join(hermesHome, 'profile.yaml'), true); } catch { /* invalid metadata falls back to Default */ }
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

function publicProfile(target: LocalProfileTarget): HermesProfile {
  const {
    hermesHome: _home,
    workspaceDir: _workspace,
    skillsDir: _skills,
    scheduledOutputDir: _cron,
    ...profile
  } = target;
  return profile;
}

export function discoverLocalProfiles(hermesHome = resolveHermesHome(), includeInactive = true): HermesProfile[] {
  return discoverLocalProfileTargets(hermesHome)
    .filter((profile) => includeInactive || profile.active)
    .map(publicProfile);
}

function validatedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new LocalProfileError(400, `${field} must be a string`, 'INVALID_PROFILE_SETTINGS');
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new LocalProfileError(400, `${field} is too long`, 'INVALID_PROFILE_SETTINGS');
  if (/\p{Cc}/u.test(trimmed)) throw new LocalProfileError(400, `${field} contains invalid control characters`, 'INVALID_PROFILE_SETTINGS');
  return trimmed;
}

function validatedProfileId(value: unknown): string {
  const id = validatedText(value, 'id', MAX_PROFILE_ID);
  if (!PROFILE_ID_PATTERN.test(id) || id === DEFAULT_PROFILE_NAME) {
    throw new LocalProfileError(400, 'id must be a lowercase immutable slug using letters, numbers, dots, dashes, or underscores', 'INVALID_PROFILE_ID');
  }
  return id;
}

function validatedOptionalSetting(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  return validatedText(value, field, MAX_MODEL_VALUE);
}

function validatedReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new LocalProfileError(400, `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}`, 'INVALID_PROFILE_SETTINGS');
  }
  return value as ReasoningEffort;
}

function validatedSoul(value: unknown): string {
  if (typeof value !== 'string') throw new LocalProfileError(400, 'soul must be a string', 'INVALID_PROFILE_SETTINGS');
  if (Buffer.byteLength(value, 'utf8') > MAX_SOUL_BYTES) {
    throw new LocalProfileError(413, 'soul is too large', 'INVALID_PROFILE_SETTINGS');
  }
  return value;
}

async function appendAudit(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function appendGlobalLifecycleAudit(lifecycleHome: string, value: Record<string, unknown>): Promise<void> {
  const logsDir = lifecycleHome === resolveMinionsHome()
    ? resolveMinionsLogsDir()
    : join(lifecycleHome, 'logs');
  await appendAudit(join(logsDir, 'profile-lifecycle.jsonl'), value);
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

export class LocalProfileRegistry {
  constructor(
    public readonly hermesHome = resolveHermesHome(),
    public readonly lifecycleHome = resolveMinionsHome(),
  ) {}

  publicProfiles(): HermesProfile[] {
    return discoverLocalProfiles(this.hermesHome, false);
  }

  allPublicProfiles(): HermesProfile[] {
    return discoverLocalProfiles(this.hermesHome, true);
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

  requireActive(id: string): LocalProfileTarget {
    const target = this.require(id);
    if (!target.active) throw new LocalProfileError(409, `Hermes profile is inactive: ${id}`, 'INACTIVE_PROFILE');
    return target;
  }

  async create(value: unknown): Promise<LocalProfileTarget> {
    return createLocalProfile(this, value);
  }

  async setActive(id: string, active: boolean, currentProfileId: string): Promise<LocalProfileTarget> {
    return setLocalProfileActive(this, id, active, currentProfileId);
  }

  async delete(id: string, confirmation: unknown, currentProfileId: string, accompanyingData?: unknown): Promise<{ backupDir: string }> {
    return deleteLocalProfile(this, id, confirmation, currentProfileId, accompanyingData);
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
  return { profileName: registry.requireActive(requested).id, routingSource: 'manual' };
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
      if (!displayName) throw new LocalProfileError(400, 'displayName is required', 'INVALID_PROFILE_SETTINGS');
      for (const key of DISPLAY_KEYS) delete metadata[key];
      metadata.displayName = displayName;
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
    if ('reasoningEffort' in updates) agentConfig.reasoning_effort = validatedReasoningEffort(updates.reasoningEffort);
    await atomicWriteWithBackup(target, 'config.yaml', stringify(config));
    changedFiles.push('config.yaml');
  }

  if ('soul' in updates) {
    await atomicWriteWithBackup(target, 'SOUL.md', validatedSoul(updates.soul));
    changedFiles.push('SOUL.md');
  }

  if (changedFiles.length > 0) {
    await appendAudit(join(target.hermesHome, '.olympus-dispatch-audit.jsonl'), {
      action: 'profile.settings.updated',
      profileId: target.id,
      fields: Object.keys(updates).sort(),
      files: changedFiles,
    });
  }

  return readProfileSettings(target);
}

export async function createLocalProfile(registry: LocalProfileRegistry, value: unknown): Promise<LocalProfileTarget> {
  const input = recordValue(value);
  if (!input) throw new LocalProfileError(400, 'Request body is required', 'INVALID_PROFILE_SETTINGS');
  const allowed = new Set(['id', 'displayName', 'description', 'model', 'provider', 'reasoningEffort', 'soul', 'active']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new LocalProfileError(400, `Unsupported profile setting: ${unknown[0]}`, 'INVALID_PROFILE_SETTINGS');

  const id = validatedProfileId(input.id);
  const displayName = validatedText(input.displayName, 'displayName', MAX_DISPLAY_NAME);
  if (!displayName) throw new LocalProfileError(400, 'displayName is required', 'INVALID_PROFILE_SETTINGS');
  const description = validatedText(input.description ?? '', 'description', MAX_DESCRIPTION);
  const model = validatedOptionalSetting(input.model ?? null, 'model');
  const provider = validatedOptionalSetting(input.provider ?? null, 'provider');
  const reasoningEffort = validatedReasoningEffort(input.reasoningEffort ?? null);
  const soul = validatedSoul(input.soul ?? '');
  if (input.active !== undefined && typeof input.active !== 'boolean') {
    throw new LocalProfileError(400, 'active must be a boolean', 'INVALID_PROFILE_SETTINGS');
  }
  const active = input.active !== false;

  const profilesHome = join(registry.hermesHome, 'profiles');
  const finalHome = join(profilesHome, id);
  if (registry.get(id) || existsSync(finalHome)) {
    throw new LocalProfileError(409, `Profile already exists: ${id}`, 'PROFILE_EXISTS');
  }

  const tempHome = join(profilesHome, `.${id}.${randomUUID()}.tmp`);
  const metadata = { displayName, description, active };
  const config: Record<string, unknown> = {};
  if (model || provider) config.model = { default: model, provider };
  if (reasoningEffort) config.agent = { reasoning_effort: reasoningEffort };

  await mkdir(join(tempHome, 'workspace'), { recursive: true });
  await mkdir(join(tempHome, 'skills'), { recursive: true });
  await mkdir(join(tempHome, 'cron', 'output'), { recursive: true });
  await Promise.all([
    writeFile(join(tempHome, 'profile.yaml'), stringify(metadata), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(tempHome, 'config.yaml'), stringify(config), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(tempHome, 'SOUL.md'), soul, { encoding: 'utf8', mode: 0o600 }),
  ]);
  await appendAudit(join(tempHome, '.olympus-dispatch-audit.jsonl'), {
    action: 'profile.created',
    profileId: id,
    fields: (['displayName', 'description', 'model', 'provider', 'reasoningEffort', 'soul', 'active'] satisfies Array<keyof HermesProfileCreateInput>),
  });

  try {
    await rename(tempHome, finalHome);
  } catch (error) {
    await rm(tempHome, { recursive: true, force: true });
    throw error;
  }
  await appendGlobalLifecycleAudit(registry.lifecycleHome, { action: 'profile.created', profileId: id, active });
  return registry.require(id);
}

export async function setLocalProfileActive(
  registry: LocalProfileRegistry,
  id: string,
  active: boolean,
  currentProfileId: string,
): Promise<LocalProfileTarget> {
  const target = registry.require(id);
  if (!active && target.isDefault) {
    throw new LocalProfileError(409, 'The default profile cannot be deactivated', 'PROTECTED_PROFILE');
  }
  if (!active && target.id === currentProfileId) {
    throw new LocalProfileError(409, 'The current profile cannot be deactivated', 'CURRENT_PROFILE');
  }
  if (target.active === active) return target;

  const metadataPath = join(target.hermesHome, 'profile.yaml');
  const metadata = existsSync(metadataPath) ? readYamlRecord(metadataPath) : {};
  metadata.active = active;
  await atomicWriteWithBackup(target, 'profile.yaml', stringify(metadata));
  await appendAudit(join(target.hermesHome, '.olympus-dispatch-audit.jsonl'), {
    action: active ? 'profile.reactivated' : 'profile.deactivated',
    profileId: target.id,
  });
  await appendGlobalLifecycleAudit(registry.lifecycleHome, {
    action: active ? 'profile.reactivated' : 'profile.deactivated',
    profileId: target.id,
  });
  return registry.require(id);
}

async function safeResolvedProfileRoot(registry: LocalProfileRegistry, target: LocalProfileTarget): Promise<string> {
  const profilesHome = await realpath(join(registry.hermesHome, 'profiles'));
  const resolvedTarget = await realpath(target.hermesHome);
  if (dirname(resolvedTarget) !== profilesHome || basename(resolvedTarget) !== target.id) {
    throw new LocalProfileError(409, 'Refusing to delete a profile outside the resolved profiles directory', 'UNSAFE_PROFILE_PATH');
  }
  return resolvedTarget;
}

export async function deleteLocalProfile(
  registry: LocalProfileRegistry,
  id: string,
  confirmation: unknown,
  currentProfileId: string,
  accompanyingData?: unknown,
): Promise<{ backupDir: string }> {
  const target = registry.require(id);
  if (target.isDefault) throw new LocalProfileError(409, 'The default profile cannot be deleted', 'PROTECTED_PROFILE');
  if (target.id === currentProfileId) throw new LocalProfileError(409, 'The current profile cannot be deleted', 'CURRENT_PROFILE');
  if (confirmation !== target.id) {
    throw new LocalProfileError(400, `Type the immutable profile ID “${target.id}” to confirm deletion`, 'PROFILE_ID_CONFIRMATION_REQUIRED');
  }

  const resolvedTarget = await safeResolvedProfileRoot(registry, target);
  await appendAudit(join(resolvedTarget, '.olympus-dispatch-audit.jsonl'), {
    action: 'profile.delete.requested',
    profileId: target.id,
  });

  const backupsRoot = registry.lifecycleHome === resolveMinionsHome()
    ? resolveMinionsBackupsDir()
    : join(registry.lifecycleHome, 'backups');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(backupsRoot, 'profiles', `${timestamp}-${target.id}`);
  await mkdir(dirname(backupDir), { recursive: true });
  await cp(resolvedTarget, backupDir, { recursive: true, errorOnExist: true, force: false });
  if (accompanyingData !== undefined) {
    await writeFile(join(backupDir, 'olympus-profile-data.json'), `${JSON.stringify(accompanyingData, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  await appendGlobalLifecycleAudit(registry.lifecycleHome, {
    action: 'profile.deleted',
    profileId: target.id,
    backupDir,
  });
  await rm(resolvedTarget, { recursive: true, force: false });
  return { backupDir };
}
