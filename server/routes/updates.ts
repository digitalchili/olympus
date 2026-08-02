import { Router } from 'express';
import { getAppVersion } from '../version.js';

const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

type UpdateStatus = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateConfigured: boolean;
  releaseUrl: string | null;
  checkedAt: number;
  error?: string;
};

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
    ?? parseGitHubRepositoryUrl('https://github.com/leakim69/olympus-dispatch.git');
}

function getUpdateUrl(): string | null {
  const value = process.env.OLYMPUS_DISPATCH_UPDATE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fetchStatus(force = false): Promise<UpdateStatus> {
  if (!force && cachedStatus && Date.now() - cachedAt < CACHE_TTL_MS) return cachedStatus;

  const { version: currentVersion } = getAppVersion();
  const repository = getRepository();
  const checkedAt = Date.now();
  const base: UpdateStatus = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    updateConfigured: Boolean(getUpdateUrl()),
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
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'olympus-dispatch' },
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
    const updateUrl = getUpdateUrl();
    const status = await fetchStatus(true);
    if (!status.updateAvailable) {
      return res.status(409).json({ error: 'No newer GitHub release is available.' });
    }
    if (!updateUrl) {
      return res.status(503).json({ error: 'No external update hook is configured.' });
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(updateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repository: getRepository(),
          currentVersion: status.currentVersion,
          latestVersion: status.latestVersion,
          releaseUrl: status.releaseUrl,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return res.status(502).json({ error: `The deployment hook rejected the update (${response.status}).` });
      }
      return res.status(202).json({ accepted: true });
    } catch {
      return res.status(502).json({ error: 'The deployment hook could not be reached.' });
    }
  });

  return router;
}
