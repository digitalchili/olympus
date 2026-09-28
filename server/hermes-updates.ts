import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import type { HermesCompatibility, HermesRuntimeInfo, HermesUpdateOperation, HermesUpdateStatus } from '../shared/hermes-updates.js';
import { getAppVersion } from './version.js';
import { isVersionNewer } from './routes/updates.js';

const REPOSITORY = 'digitalchili/olympus';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ACTIVE = new Set(['preparing', 'draining', 'backing_up', 'installing', 'verifying', 'interrupted']);
const PHASES = new Set([...ACTIVE, 'idle', 'completed', 'failed', 'rolled_back']);
const UNKNOWN: HermesRuntimeInfo = { available: false, version: null, revision: null, installation: 'unknown', sourcePath: null, pythonPath: null, dirty: null };

export function parseHermesCompatibility(value: unknown): HermesCompatibility {
  const data = value as Partial<HermesCompatibility> | null;
  if (!data || data.schemaVersion !== 1 || typeof data.version !== 'string' || !/^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/.test(data.version)
    || typeof data.revision !== 'string' || !/^[a-f0-9]{40}$/.test(data.revision)
    || typeof data.image !== 'string' || !new RegExp(`^nousresearch/hermes-agent:v${data.version.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`).test(data.image)
    || data.releaseUrl !== `https://github.com/NousResearch/hermes-agent/releases/tag/v${data.version}`) {
    throw new Error('Hermes compatibility information is unavailable.');
  }
  return { schemaVersion: 1, version: data.version, revision: data.revision, image: data.image, releaseUrl: data.releaseUrl };
}

export function loadHermesCompatibility(): HermesCompatibility {
  // Source checkout and compiled npm/Docker assets have different depths.
  for (const location of [new URL('./hermes-runtime.json', import.meta.url), new URL('../hermes-runtime.json', import.meta.url)]) {
    try { return parseHermesCompatibility(JSON.parse(readFileSync(location, 'utf8'))); } catch { /* try bundled path */ }
  }
  throw new Error('This Olympus build has no verified Hermes compatibility information.');
}

interface TargetRelease { target: HermesCompatibility; olympusVersion: string }
let cachedRelease: { at: number; value: TargetRelease } | null = null;
export async function latestHermesTarget(refresh = false): Promise<TargetRelease> {
  if (!refresh && cachedRelease && Date.now() - cachedRelease.at < 300_000) return cachedRelease.value;
  cachedRelease = null;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'olympus-dispatch' }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Release check unavailable.');
  const release = await response.json() as Record<string, unknown>;
  const olympusVersion = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  if (!VERSION.test(olympusVersion) || release.draft !== false || release.prerelease !== false
    || !olympusVersion.split('.').every(value => Number.isSafeInteger(Number(value)))
    || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) throw new Error('No stable release.');
  const manifest = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/v${olympusVersion}/hermes-runtime.json`, { signal: AbortSignal.timeout(10_000) });
  if (!manifest.ok) throw new Error('Release compatibility information unavailable.');
  const value = { target: parseHermesCompatibility(await manifest.json()), olympusVersion };
  cachedRelease = { at: Date.now(), value };
  return value;
}

export interface HermesUpdateRequest { repository: string; olympusVersion: string; target: HermesCompatibility }
// Only the installation-local authenticated Unix socket can execute updates.
// The web process never accepts a shell command, service ID, URL or filesystem path.
export async function hermesUpdateHook(method: 'GET' | 'POST', body?: HermesUpdateRequest): Promise<any> {
  const socketPath = process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET?.trim();
  const token = process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN?.trim();
  if (!socketPath || !isAbsolute(socketPath) || !token) throw new Error('Updater unavailable.');
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = request({ socketPath, path: '/hermes', method, headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } }, res => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { result += chunk; if (result.length > 32_768) req.destroy(new Error('Invalid updater response.')); });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('Updater rejected request.'));
        try { resolve(JSON.parse(result)); } catch { reject(new Error('Invalid updater response.')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Updater unavailable.')));
    req.on('error', reject); req.end(payload);
  });
}

function parseOperation(raw: unknown): HermesUpdateOperation | null {
  if (raw === null || raw === undefined) return null;
  const value = raw as HermesUpdateOperation;
  // The helper deliberately returns this sentinel when a durable receipt is
  // corrupt. Preserve recovery guidance even though no target can be trusted.
  if (value?.phase === 'interrupted' && value.targetRevision === '') return {
    id: 'unknown', phase: 'interrupted', targetRevision: '', targetVersion: '', startedAt: 0, updatedAt: 0,
    message: 'Update status needs local recovery before another update.',
  };
  if (!value || typeof value.id !== 'string' || !PHASES.has(value.phase) || !/^[a-f0-9]{40}$/.test(value.targetRevision)
    || typeof value.targetVersion !== 'string' || typeof value.message !== 'string' || value.message.length > 500
    || !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)) throw new Error('Invalid update state.');
  return { id: value.id, phase: value.phase, targetRevision: value.targetRevision, targetVersion: value.targetVersion, startedAt: value.startedAt, updatedAt: value.updatedAt, message: value.message };
}

export function createHermesUpdateService(deps: {
  runtime: () => Promise<HermesRuntimeInfo>;
  version?: () => string;
  localTarget?: () => HermesCompatibility;
  latestTarget?: (refresh: boolean) => Promise<TargetRelease>;
  hook?: typeof hermesUpdateHook;
}) {
  const hook = deps.hook ?? hermesUpdateHook;
  async function status(refresh = false): Promise<HermesUpdateStatus> {
    const olympusVersion = (deps.version ?? (() => getAppVersion().version))();
    const [runtimeResult, hookResult] = await Promise.allSettled([deps.runtime(), hook('GET')]);
    const current = runtimeResult.status === 'fulfilled' ? runtimeResult.value : UNKNOWN;
    let method: HermesUpdateStatus['method'] = 'unavailable';
    let operation: HermesUpdateOperation | null = null;
    let configured = false;
    try {
      if (hookResult.status === 'fulfilled') {
        const info = hookResult.value;
        if (['native', 'docker', 'dokploy'].includes(info.method)) method = info.method;
        configured = info.configured === true && method !== 'unavailable';
        operation = parseOperation(info.operation);
      }
    } catch { configured = false; }
    let target: HermesCompatibility | null = null;
    let targetOlympusVersion: string | null = null;
    let error: string | undefined;
    try {
      if (current.installation === 'docker') {
        const release = await (deps.latestTarget ?? latestHermesTarget)(refresh);
        if (isVersionNewer(olympusVersion, release.olympusVersion)) throw new Error('Release older than current installation.');
        target = release.target; targetOlympusVersion = release.olympusVersion;
      } else { target = (deps.localTarget ?? loadHermesCompatibility)(); targetOlympusVersion = olympusVersion; }
    } catch { error = 'The tested Hermes release could not be checked. Try again later.'; }
    const updateAvailable = !!(target && current.revision && target.revision !== current.revision);
    let reason: string | null = null;
    if (!current.available || !current.revision) reason = 'The running Hermes installation could not be identified safely.';
    else if (error) reason = error;
    else if (operation && ACTIVE.has(operation.phase)) reason = operation.phase === 'interrupted' ? 'The previous update was interrupted. Check the installation before retrying.' : 'A Hermes update is already in progress.';
    else if (!configured) reason = 'Set up the installation-local Hermes updater to enable this button.';
    else if ((current.installation === 'docker' && method !== 'docker' && method !== 'dokploy') || (current.installation !== 'docker' && (method !== 'native' || current.installation !== 'source'))) reason = 'The updater does not match this installation type.';
    else if (current.installation === 'source' && current.dirty !== false) reason = 'Hermes has local changes or its source state is unknown. Resolve them before updating.';
    else if (!updateAvailable) reason = 'Hermes matches the tested release for this Olympus version.';
    return { current, target, olympusVersion, targetOlympusVersion, method, updateAvailable, canApply: reason === null && updateAvailable, reason, operation, checkedAt: Date.now(), ...(error ? { error } : {}) };
  }
  return {
    status,
    async apply(revision: unknown, olympusVersion: unknown) {
      const checked = await status(true);
      if (!checked.canApply || checked.target?.revision !== revision || checked.targetOlympusVersion !== olympusVersion) return null;
      const result = await hook('POST', { repository: REPOSITORY, olympusVersion: checked.targetOlympusVersion!, target: checked.target! });
      if (result?.accepted !== true || typeof result.operationId !== 'string') throw new Error('Invalid update acknowledgement.');
      return { accepted: true, operationId: result.operationId };
    },
  };
}
