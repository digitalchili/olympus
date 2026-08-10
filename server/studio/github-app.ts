import { createSign } from 'node:crypto';
import type { StudioGitHubRepository } from '../../shared/types.js';
import type { StudioGitHubGateway } from '../routes/studio.js';

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;

type Environment = Record<string, string | undefined>;

interface GitHubAppOptions {
  env?: Environment;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface GitHubAppConfig {
  appId: string;
  appSlug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

function readConfig(env: Environment): GitHubAppConfig | null {
  const appId = env.OLYMPUS_STUDIO_GITHUB_APP_ID?.trim();
  const appSlug = env.OLYMPUS_STUDIO_GITHUB_APP_SLUG?.trim();
  const privateKey = env.OLYMPUS_STUDIO_GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  const clientId = env.OLYMPUS_STUDIO_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.OLYMPUS_STUDIO_GITHUB_CLIENT_SECRET?.trim();
  return appId && appSlug && privateKey && clientId && clientSecret
    ? { appId, appSlug, privateKey, clientId, clientSecret }
    : null;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function appJwt(config: GitHubAppConfig, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const encodedHeader = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const encodedPayload = encodeJson({
    iat: issuedAt,
    exp: Math.floor(nowMs / 1000) + 9 * 60,
    iss: config.appId,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(config.privateKey).toString('base64url')}`;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${authorization}`,
    'User-Agent': 'olympus-dispatch-studio',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`GitHub response is missing ${field}.`);
  return value;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`GitHub response has an invalid ${field}.`);
  return Number(value);
}

export function createGitHubAppGateway(options: GitHubAppOptions = {}): StudioGitHubGateway {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const config = readConfig(env);

  function requireConfig(): GitHubAppConfig {
    if (!config) throw new Error('The Studio GitHub App is not configured.');
    return config;
  }

  async function appRequest(path: string, init?: RequestInit): Promise<Response> {
    const activeConfig = requireConfig();
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        ...githubHeaders(appJwt(activeConfig, now())),
        ...init?.headers as Record<string, string> | undefined,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub App request failed (${response.status}).`);
    return response;
  }

  async function installationToken(installationId: number): Promise<string> {
    const response = await appRequest(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: { metadata: 'read' } }),
    });
    const payload = await response.json() as { token?: unknown };
    return requiredString(payload.token, 'installation token');
  }

  async function installationDetails(installationId: number): Promise<{
    id: number;
    accountLogin: string;
    accountType: 'User' | 'Organization';
  }> {
    const response = await appRequest(`/app/installations/${installationId}`);
    const payload = await response.json() as {
      id?: unknown;
      account?: { login?: unknown; type?: unknown };
    };
    const accountType = payload.account?.type;
    if (accountType !== 'User' && accountType !== 'Organization') {
      throw new Error('GitHub response has an invalid installation account type.');
    }
    return {
      id: requiredSafeInteger(payload.id, 'installation id'),
      accountLogin: requiredString(payload.account?.login, 'installation account login'),
      accountType,
    };
  }

  async function userAccessToken(code: string): Promise<string> {
    const activeConfig = requireConfig();
    const response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: activeConfig.clientId,
        client_secret: activeConfig.clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub user authorization failed (${response.status}).`);
    const payload = await response.json() as { access_token?: unknown; error?: unknown };
    if (typeof payload.error === 'string') throw new Error('GitHub user authorization was rejected.');
    return requiredString(payload.access_token, 'user access token');
  }

  async function userOwnsInstallation(token: string, installationId: number): Promise<boolean> {
    let expectedTotal = Number.POSITIVE_INFINITY;
    let seen = 0;
    for (let page = 1; seen < expectedTotal; page += 1) {
      const response = await fetchImpl(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub user installations request failed (${response.status}).`);
      const payload = await response.json() as {
        total_count?: unknown;
        installations?: Array<{ id?: unknown }>;
      };
      expectedTotal = Number.isSafeInteger(payload.total_count) ? Number(payload.total_count) : 0;
      const installations = Array.isArray(payload.installations) ? payload.installations : [];
      if (installations.some((installation) => installation.id === installationId)) return true;
      seen += installations.length;
      if (installations.length === 0) break;
    }
    return false;
  }

  return {
    configured: config !== null,

    installationUrl(state: string): string {
      const activeConfig = requireConfig();
      return `https://github.com/apps/${encodeURIComponent(activeConfig.appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
    },

    authorizationUrl(state: string): string {
      const activeConfig = requireConfig();
      return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(activeConfig.clientId)}&state=${encodeURIComponent(state)}`;
    },

    async authorizeInstallation(code: string, installationId: number) {
      const token = await userAccessToken(code);
      if (!await userOwnsInstallation(token, installationId)) {
        throw new Error('GitHub installation is not associated with the authorized user.');
      }
      return installationDetails(installationId);
    },

    async listRepositories(installationId: number): Promise<StudioGitHubRepository[]> {
      const token = await installationToken(installationId);
      const repositories: StudioGitHubRepository[] = [];
      let expectedTotal = Number.POSITIVE_INFINITY;

      for (let page = 1; repositories.length < expectedTotal; page += 1) {
        const response = await fetchImpl(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
          headers: githubHeaders(token),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`GitHub installation request failed (${response.status}).`);
        const payload = await response.json() as {
          total_count?: unknown;
          repositories?: Array<{
            id?: unknown;
            name?: unknown;
            full_name?: unknown;
            owner?: { login?: unknown };
            private?: unknown;
            default_branch?: unknown;
            html_url?: unknown;
            clone_url?: unknown;
          }>;
        };
        expectedTotal = Number.isSafeInteger(payload.total_count) ? Number(payload.total_count) : 0;
        const pageRepositories = Array.isArray(payload.repositories) ? payload.repositories : [];
        for (const repository of pageRepositories) {
          repositories.push({
            id: requiredSafeInteger(repository.id, 'repository id'),
            name: requiredString(repository.name, 'repository name'),
            fullName: requiredString(repository.full_name, 'repository full name'),
            owner: requiredString(repository.owner?.login, 'repository owner'),
            private: repository.private === true,
            defaultBranch: requiredString(repository.default_branch, 'repository default branch'),
            htmlUrl: requiredString(repository.html_url, 'repository HTML URL'),
            cloneUrl: requiredString(repository.clone_url, 'repository clone URL'),
          });
        }
        if (pageRepositories.length === 0) break;
      }

      return repositories;
    },
  };
}
