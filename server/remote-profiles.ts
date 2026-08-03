import { readFileSync } from 'node:fs';
import type { RemoteProfileId, RemoteProfilePublic, TaskRoutingSource } from '../shared/types.js';

export const REMOTE_PROFILE_IDS = ['som', 'somchai', 'somboon'] as const satisfies readonly RemoteProfileId[];

export interface RemoteProfileTarget {
  id: RemoteProfileId;
  label: string;
  description: string;
  icon: string;
  remoteProfile: string;
  remotePath: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  available: boolean;
}

interface RegistryConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  remoteProfile?: string;
  remotePath?: string | null;
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

const DEFAULT_TARGETS: Record<RemoteProfileId, Omit<RemoteProfileTarget, 'baseUrl' | 'apiKey' | 'available'>> = {
  som: {
    id: 'som',
    label: 'Som',
    description: 'Spirit House wine execution agent on the Somboon VPS.',
    icon: 'wine',
    remoteProfile: 'som-spirithouse-wine',
    remotePath: null,
  },
  somchai: {
    id: 'somchai',
    label: 'Somchai',
    description: 'Chili Radio execution agent on the Somboon VPS.',
    icon: 'radio',
    remoteProfile: 'somchai-chili-radio',
    remotePath: null,
  },
  somboon: {
    id: 'somboon',
    label: 'Somboon',
    description: 'Default remote execution agent on the Somboon VPS.',
    icon: 'server',
    remoteProfile: 'default',
    remotePath: null,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseConfig(options: BuildOptions): Partial<Record<RemoteProfileId, RegistryConfig>> {
  const text = options.json ?? (options.path ? readFileSync(options.path, 'utf8') : null);
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) return {};

  const result: Partial<Record<RemoteProfileId, RegistryConfig>> = {};
  for (const id of REMOTE_PROFILE_IDS) {
    const raw = parsed[id];
    if (!isRecord(raw)) continue;
    result[id] = {
      baseUrl: optionalString(raw.baseUrl),
      apiKeyEnv: optionalString(raw.apiKeyEnv),
      remoteProfile: optionalString(raw.remoteProfile),
      remotePath: optionalString(raw.remotePath) ?? null,
    };
  }
  return result;
}

function resolveEnvReference(value: string | undefined, env: BuildOptions['env']): string | null {
  if (!value) return null;
  if (value.startsWith('$')) return env?.[value.slice(1)]?.trim() || null;
  return value;
}

export class RemoteProfileRegistry {
  constructor(private targets: Map<RemoteProfileId, RemoteProfileTarget>) {}

  publicProfiles(): RemoteProfilePublic[] {
    return REMOTE_PROFILE_IDS.map((id) => {
      const target = this.targets.get(id);
      if (!target) throw new Error(`Missing default remote profile ${id}`);
      return {
        id: target.id,
        label: target.label,
        description: target.description,
        icon: target.icon,
        available: target.available,
        remoteProfile: target.remoteProfile,
      };
    });
  }

  get(id: string | null | undefined): RemoteProfileTarget | null {
    if (!id || !REMOTE_PROFILE_IDS.includes(id as RemoteProfileId)) return null;
    return this.targets.get(id as RemoteProfileId) ?? null;
  }

  requireAvailable(id: string): RemoteProfileTarget {
    const target = this.get(id);
    if (!target) throw new RemoteProfileRoutingError(400, `Unknown remote profile: ${id}`);
    if (!target.available) throw new RemoteProfileRoutingError(409, `Remote profile ${target.label} is unavailable`);
    return target;
  }
}

export function buildRemoteProfileRegistry(options: BuildOptions = {}): RemoteProfileRegistry {
  const env = options.env ?? process.env;
  const config = parseConfig({
    env,
    json: options.json ?? process.env.OLYMPUS_REMOTE_PROFILES_JSON,
    path: options.path ?? process.env.OLYMPUS_REMOTE_PROFILES_PATH,
  });
  const targets = new Map<RemoteProfileId, RemoteProfileTarget>();

  for (const id of REMOTE_PROFILE_IDS) {
    const defaults = DEFAULT_TARGETS[id];
    const override = config[id] ?? {};
    const baseUrl = resolveEnvReference(override.baseUrl, env);
    const apiKey = override.apiKeyEnv ? env[override.apiKeyEnv]?.trim() || null : null;
    targets.set(id, {
      ...defaults,
      remoteProfile: override.remoteProfile ?? defaults.remoteProfile,
      remotePath: override.remotePath ?? defaults.remotePath,
      baseUrl,
      apiKey,
      available: Boolean(baseUrl && apiKey),
    });
  }

  return new RemoteProfileRegistry(targets);
}

export const remoteProfileRegistry = buildRemoteProfileRegistry();

function isClearWineRequest(description: string): boolean {
  return /\bwine\b/i.test(description) || /\bspirit\s*house\b/i.test(description);
}

function isClearChiliRadioRequest(description: string): boolean {
  return /\bchili\s+radio\b/i.test(description);
}

export function resolveTaskRouting(
  registry: RemoteProfileRegistry,
  input: { requestedProfileName?: unknown; description: string },
): { profileName: RemoteProfileId | null; routingSource: TaskRoutingSource | null } {
  const requested = typeof input.requestedProfileName === 'string' ? input.requestedProfileName.trim() : '';
  if (requested) {
    const target = registry.requireAvailable(requested);
    return { profileName: target.id, routingSource: 'manual' };
  }

  if (isClearChiliRadioRequest(input.description)) {
    registry.requireAvailable('somchai');
    return { profileName: 'somchai', routingSource: 'automatic' };
  }

  if (isClearWineRequest(input.description)) {
    registry.requireAvailable('som');
    return { profileName: 'som', routingSource: 'automatic' };
  }

  if (registry.get('somboon')?.available) {
    return { profileName: 'somboon', routingSource: 'automatic' };
  }
  return { profileName: null, routingSource: null };
}
