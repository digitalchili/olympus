import { readFileSync } from 'node:fs';
import type { RemoteProfilePublic, TaskRoutingSource } from '../shared/types.js';

type SecretText = string;

export interface RemoteProfileTarget {
  id: string;
  label: string;
  description: string;
  icon: string;
  remoteProfile: string;
  remotePath: string | null;
  apiKey: SecretText | null;
  baseUrl: string | null;
  available: boolean;
}

interface ProfileConfig {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  remoteProfile?: string;
  remotePath?: string | null;
}

interface RoutingRuleConfig {
  profile: string;
  keywords: string[];
}

interface ParsedConfig {
  profiles: ProfileConfig[];
  defaultProfile: string | null;
  routingRules: RoutingRuleConfig[];
}

interface BuildOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  json?: string | null;
  path?: string | null;
}

export class RemoteProfileRoutingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RemoteProfileRoutingError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireProfileId(value: unknown, context: string): string {
  const id = optionalString(value);
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`${context} must have a valid id`);
  }
  return id;
}

function parseProfile(raw: unknown, fallbackId?: string): ProfileConfig {
  if (!isRecord(raw)) throw new Error('Remote profile entries must be objects');
  const id = requireProfileId(raw.id ?? fallbackId, 'Remote profile');
  const label = optionalString(raw.label) ?? id;
  return {
    id,
    label,
    description: optionalString(raw.description) ?? '',
    icon: optionalString(raw.icon) ?? 'server',
    baseUrl: optionalString(raw.baseUrl),
    apiKeyEnv: optionalString(raw.apiKeyEnv),
    remoteProfile: optionalString(raw.remoteProfile) ?? id,
    remotePath: optionalString(raw.remotePath) ?? null,
  };
}

function parseProfiles(parsed: Record<string, unknown>): ProfileConfig[] {
  if (Array.isArray(parsed.profiles)) return parsed.profiles.map((entry) => parseProfile(entry));
  if (parsed.profiles !== undefined) throw new Error('Remote profiles must be an array');

  // Backward-compatible map form: { "profile-id": { ... } }.
  return Object.entries(parsed)
    .filter(([key]) => key !== 'defaultProfile' && key !== 'routingRules')
    .map(([id, entry]) => parseProfile(entry, id));
}

function parseRoutingRules(value: unknown): RoutingRuleConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Remote profile routingRules must be an array');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Remote profile routing rules must be objects');
    const profile = requireProfileId(entry.profile, 'Routing rule profile');
    if (!Array.isArray(entry.keywords)) throw new Error(`Routing rule for ${profile} must define keywords`);
    const keywords = entry.keywords.map(optionalString).filter((keyword): keyword is string => Boolean(keyword));
    if (keywords.length === 0) throw new Error(`Routing rule for ${profile} must define at least one keyword`);
    return { profile, keywords };
  });
}

function parseConfig(options: BuildOptions): ParsedConfig {
  const text = options.json ?? (options.path ? readFileSync(options.path, 'utf8') : null);
  if (!text) return { profiles: [], defaultProfile: null, routingRules: [] };
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error('Remote profile configuration must be an object');

  const profiles = parseProfiles(parsed);
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`Duplicate remote profile: ${profile.id}`);
    ids.add(profile.id);
  }

  const defaultProfile = optionalString(parsed.defaultProfile) ?? null;
  if (defaultProfile && !ids.has(defaultProfile)) {
    throw new Error(`Default profile ${defaultProfile} is not configured`);
  }

  const routingRules = parseRoutingRules(parsed.routingRules);
  for (const rule of routingRules) {
    if (!ids.has(rule.profile)) throw new Error(`Routing rule references missing profile ${rule.profile}`);
  }
  return { profiles, defaultProfile, routingRules };
}

function resolveEnvReference(value: string | undefined, env: BuildOptions['env']): string | null {
  if (!value) return null;
  if (value.startsWith('$')) return env?.[value.slice(1)]?.trim() || null;
  return value;
}

export class RemoteProfileRegistry {
  constructor(
    private targets: Map<string, RemoteProfileTarget>,
    private defaultProfile: string | null,
    private routingRules: RoutingRuleConfig[],
  ) {}

  publicProfiles(): RemoteProfilePublic[] {
    return [...this.targets.values()].map((target) => ({
      id: target.id,
      label: target.label,
      description: target.description,
      icon: target.icon,
      available: target.available,
      remoteProfile: target.remoteProfile,
    }));
  }

  get(id: string | null | undefined): RemoteProfileTarget | null {
    return id ? this.targets.get(id) ?? null : null;
  }

  requireAvailable(id: string): RemoteProfileTarget {
    const target = this.get(id);
    if (!target) throw new RemoteProfileRoutingError(400, `Unknown remote profile: ${id}`);
    if (!target.available) throw new RemoteProfileRoutingError(409, `Remote profile ${target.label} is unavailable`);
    return target;
  }

  automaticProfile(description: string): string | null {
    const normalized = description.toLowerCase();
    const matched = this.routingRules.find((rule) =>
      rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())),
    );
    return matched?.profile ?? this.defaultProfile;
  }
}

export function buildRemoteProfileRegistry(options: BuildOptions = {}): RemoteProfileRegistry {
  const env = options.env ?? process.env;
  const config = parseConfig({
    env,
    json: options.json ?? process.env.OLYMPUS_REMOTE_PROFILES_JSON,
    path: options.path ?? process.env.OLYMPUS_REMOTE_PROFILES_PATH,
  });
  const targets = new Map<string, RemoteProfileTarget>();

  for (const profile of config.profiles) {
    const baseUrl = resolveEnvReference(profile.baseUrl, env);
    const apiKey = profile.apiKeyEnv ? env[profile.apiKeyEnv]?.trim() || null : null;
    targets.set(profile.id, {
      id: profile.id,
      label: profile.label,
      description: profile.description ?? '',
      icon: profile.icon ?? 'server',
      remoteProfile: profile.remoteProfile ?? profile.id,
      remotePath: profile.remotePath ?? null,
      baseUrl,
      apiKey,
      available: Boolean(baseUrl && apiKey),
    });
  }

  return new RemoteProfileRegistry(targets, config.defaultProfile, config.routingRules);
}

export const remoteProfileRegistry = buildRemoteProfileRegistry();

export function resolveTaskRouting(
  registry: RemoteProfileRegistry,
  input: { requestedProfileName?: unknown; description: string },
): { profileName: string | null; routingSource: TaskRoutingSource | null } {
  const requested = typeof input.requestedProfileName === 'string' ? input.requestedProfileName.trim() : '';
  if (requested) {
    const target = registry.requireAvailable(requested);
    return { profileName: target.id, routingSource: 'manual' };
  }

  const automaticProfile = registry.automaticProfile(input.description);
  if (!automaticProfile) return { profileName: null, routingSource: null };
  const target = registry.requireAvailable(automaticProfile);
  return { profileName: target.id, routingSource: 'automatic' };
}
