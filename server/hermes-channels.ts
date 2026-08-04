import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isHermesMessageChannelId, type HermesChannel, type HermesChannelHealth } from '../shared/types.js';

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HEALTHY_STATES = new Set(['connected', 'running', 'ok']);
const DEGRADED_STATES = new Set(['disconnected', 'fatal', 'error', 'paused', 'retrying']);


function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readRecord(path: string, format: 'json' | 'yaml'): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8');
    const value = format === 'json' ? JSON.parse(text) as unknown : parse(text) as unknown;
    return record(value) ?? {};
  } catch {
    return {};
  }
}

function platformMap(parent: Record<string, unknown>, key = 'platforms'): Record<string, unknown> {
  return record(parent[key]) ?? {};
}

function explicitEnabled(value: unknown): boolean | null {
  const enabled = record(value)?.enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

function displayLabel(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function channelHealth(enabled: boolean, runtimeState: unknown, gatewayState: unknown): HermesChannelHealth {
  if (!enabled) return 'inactive';
  const state = typeof runtimeState === 'string' ? runtimeState.trim().toLowerCase() : '';
  const gateway = typeof gatewayState === 'string' ? gatewayState.trim().toLowerCase() : '';
  if (gateway && gateway !== 'running' && gateway !== 'draining') return 'degraded';
  if (HEALTHY_STATES.has(state)) return 'healthy';
  if (DEGRADED_STATES.has(state)) return 'degraded';
  return 'unknown';
}

/**
 * Read Hermes-owned configuration and runtime status without reading .env or
 * returning any provider credentials, chat IDs, errors, paths, or QR/session data.
 */
export async function discoverHermesChannels(hermesHome: string): Promise<HermesChannel[]> {
  const [legacy, config, runtime] = await Promise.all([
    readRecord(join(hermesHome, 'gateway.json'), 'json'),
    readRecord(join(hermesHome, 'config.yaml'), 'yaml'),
    readRecord(join(hermesHome, 'gateway_state.json'), 'json'),
  ]);

  const legacyPlatforms = platformMap(legacy);
  const gateway = record(config.gateway) ?? {};
  const gatewayPlatforms = platformMap(gateway);
  const configPlatforms = platformMap(config);
  const runtimePlatforms = platformMap(runtime);
  // Only platform maps represent user-facing Hermes channels. Root config keys
  // such as `api` describe Hermes infrastructure and must never become inboxes.
  const ids = new Set([
    ...Object.keys(legacyPlatforms),
    ...Object.keys(gatewayPlatforms),
    ...Object.keys(configPlatforms),
    ...Object.keys(runtimePlatforms),
  ].filter((id) => CHANNEL_ID_PATTERN.test(id) && isHermesMessageChannelId(id)));

  return [...ids].sort().map((id) => {
    let configured: boolean | null = null;
    for (const value of [legacyPlatforms[id], gatewayPlatforms[id], configPlatforms[id], config[id]]) {
      const next = explicitEnabled(value);
      if (next !== null) configured = next;
    }
    const runtimePlatform = record(runtimePlatforms[id]);
    const enabled = configured ?? runtimePlatform !== null;
    return {
      id,
      displayLabel: displayLabel(id),
      enabled,
      health: channelHealth(enabled, runtimePlatform?.state, runtime.gateway_state),
    };
  });
}
