import { accessSync, constants, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import { Router } from 'express';
import type { UpdateStatus } from '@shared/types';
import { getAppVersion } from '../version.js';

const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

let cachedStatus: UpdateStatus | null = null;
let cachedAt = 0;

export function parseGitHubRepositoryUrl(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  const match = normalized.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function parseVersion(value: string): number[] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index++) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

function getRepository(): string | null {
  return parseGitHubRepositoryUrl(process.env.OLYMPUS_DISPATCH_GITHUB_REPOSITORY)
    ?? parseGitHubRepositoryUrl('https://github.com/digitalchili/olympus.git');
}

type UpdateHook =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'url'; url: string };

function getConfiguredUpdateHook(): UpdateHook | null {
  const socketPath = process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET?.trim();
  if (socketPath && isAbsolute(socketPath)) return { kind: 'socket', socketPath };

  const value = process.env.OLYMPUS_DISPATCH_UPDATE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    return url.protocol === 'http:' && localHosts.has(url.hostname)
      ? { kind: 'url', url: url.toString() }
      : null;
  } catch {
    return null;
  }
}

function getUpdateHook(): UpdateHook | null {
  const hook = getConfiguredUpdateHook();
  if (!hook || hook.kind === 'url') return hook;

  try {
    if (!statSync(hook.socketPath).isSocket()) return null;
    accessSync(hook.socketPath, constants.R_OK | constants.W_OK);
    return hook;
  } catch {
    return null;
  }
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'olympus-dispatch',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.OLYMPUS_DISPATCH_GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function postToSocket(socketPath: string, body: string, token: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const request = httpRequest({ socketPath, path: '/update', method: 'POST', headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 502));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Update hook timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}

async function postUpdateHook(hook: UpdateHook, body: string, token: string | undefined): Promise<number> {
  if (hook.kind === 'socket') return postToSocket(hook.socketPath, body, token);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(hook.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.status;
}

async function fetchStatus(force = false): Promise<UpdateStatus> {
  if (!force && cachedStatus && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cachedStatus, updateConfigured: Boolean(getUpdateHook()) };
  }

  const { version: currentVersion } = getAppVersion();
  const repository = getRepository();
  const checkedAt = Date.now();
  const base: UpdateStatus = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    updateConfigured: Boolean(getUpdateHook()),
    releaseUrl: null,
    checkedAt,
  };

  if (!repository) {
    cachedStatus = { ...base, error: 'A GitHub repository is not configured.' };
    cachedAt = checkedAt;
    return cachedStatus;
  }

  try {
    const response = await fetch(`${GITHUB_API}/repos/${repository}/releases/latest`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      cachedStatus = { ...base, error: 'No GitHub release is published yet.' };
    } else if (!response.ok) {
      cachedStatus = { ...base, error: `GitHub release check failed (${response.status}).` };
    } else {
      const release = await response.json() as { tag_name?: unknown; html_url?: unknown };
      const latestVersion = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : null;
      cachedStatus = {
        ...base,
        latestVersion,
        updateAvailable: latestVersion ? isVersionNewer(latestVersion, currentVersion) : false,
        releaseUrl: typeof release.html_url === 'string' ? release.html_url : null,
      };
    }
  } catch {
    cachedStatus = { ...base, error: 'GitHub release check is unavailable.' };
  }

  cachedAt = checkedAt;
  return cachedStatus;
}

export function createUpdatesRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await fetchStatus(req.query.refresh === 'true'));
  });

  router.post('/apply', async (_req, res) => {
    const updateHook = getUpdateHook();
    if (!updateHook) {
      return res.status(503).json({ error: 'No installation-local update hook is available.' });
    }
    const status = await fetchStatus(true);
    if (!status.updateAvailable) {
      return res.status(409).json({ error: 'No newer GitHub release is available.' });
    }

    try {
      const token = process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN?.trim();
      const hookStatus = await postUpdateHook(updateHook, JSON.stringify({
        repository: getRepository(),
        currentVersion: status.currentVersion,
        latestVersion: status.latestVersion,
        releaseUrl: status.releaseUrl,
      }), token);
      if (hookStatus < 200 || hookStatus >= 300) {
        return res.status(502).json({ error: `The deployment hook rejected the update (${hookStatus}).` });
      }
      return res.status(202).json({ accepted: true });
    } catch {
      return res.status(502).json({ error: 'The deployment hook could not be reached.' });
    }
  });

  return router;
}
