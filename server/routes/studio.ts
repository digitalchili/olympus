import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import type { StudioGitHubRepository } from '../../shared/types.js';
import {
  consumeGitHubConnectionState,
  createGitHubConnectionState,
  deleteGitHubInstallation,
  getGitHubInstallation,
  importGitHubProject,
  listGitHubInstallationProjects,
  listGitHubInstallations,
  listStudioProjects,
  upsertGitHubInstallation,
  updateGitHubInstallationLabel,
} from '../db/studio-projects.js';

export interface StudioGitHubGateway {
  configured: boolean;
  manifestRegistration(state: string, publicUrl: string, owner: string | null): {
    url: string;
    method: 'POST';
    fields: { state: string; manifest: string };
  };
  completeManifest(code: string): Promise<void>;
  installationUrl(state: string): string;
  authorizationUrl(state: string): string;
  authorizeInstallation(code: string, installationId: number): Promise<{
    id: number;
    accountLogin: string;
    accountType: 'User' | 'Organization';
    permissionMode: 'read_write' | 'upgrade_required';
  }>;
  listRepositories(installationId: number): Promise<StudioGitHubRepository[]>;
  installationToken?(installationId: number): Promise<string>;
}

interface StudioRouterOptions {
  github: StudioGitHubGateway;
  stateTtlMs?: number;
  now?: () => number;
  secureCookies?: boolean;
  publicUrl?: string;
}

const INSTALL_STATE_COOKIE = 'studio_github_install_state';
const MANIFEST_STATE_COOKIE = 'studio_github_manifest_state';
const OAUTH_STATE_COOKIE = 'studio_github_oauth_state';

function positiveSafeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function githubOrganizationOwner(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('invalid GitHub organization owner');
  const owner = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error('invalid GitHub organization owner');
  }
  return owner;
}

function cookieValue(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid public URL');
  }
  return url.origin;
}

function requestPublicUrl(req: Request, configured: string | undefined): string {
  const configuredOrigin = configured?.trim() ? normalizedOrigin(configured.trim()) : null;
  if (configuredOrigin) {
    if (process.env.NODE_ENV === 'production' && !configuredOrigin.startsWith('https://')) throw new Error('HTTPS is required');
    return configuredOrigin;
  }
  const originHeader = req.get('origin');
  if (!originHeader) throw new Error('missing request origin');
  const origin = normalizedOrigin(originHeader);
  const forwardedHost = req.get('x-forwarded-host')?.split(',', 1)[0]?.trim();
  const requestHost = forwardedHost || req.get('host');
  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',', 1)[0]?.trim();
  const requestProtocol = forwardedProtocol || req.protocol;
  const expected = normalizedOrigin(`${requestProtocol}://${requestHost}`);
  if (origin !== expected) throw new Error('request origin does not match public host');
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('HTTPS is required');
  return origin;
}

export function createStudioRouter(options: StudioRouterOptions): Router {
  const router = Router();
  const now = options.now ?? Date.now;
  const stateTtlMs = options.stateTtlMs ?? 10 * 60_000;
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';

  router.get('/github/status', (_req, res) => {
    res.json({
      configured: options.github.configured,
      installations: listGitHubInstallations(),
    });
  });

  router.post('/github/connect', (req, res) => {
    const state = randomBytes(32).toString('base64url');
    if (!options.github.configured) {
      try {
        const owner = githubOrganizationOwner(req.body?.owner);
        const publicUrl = requestPublicUrl(req, options.publicUrl);
        createGitHubConnectionState(state, 'manifest', now() + stateTtlMs);
        res.cookie(MANIFEST_STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: 'lax',
          secure: secureCookies,
          maxAge: stateTtlMs,
          path: '/api/studio/github/manifest/callback',
        });
        return res.json(options.github.manifestRegistration(state, publicUrl, owner));
      } catch {
        return res.status(400).json({ error: 'Olympus could not start secure GitHub App setup.' });
      }
    }
    createGitHubConnectionState(state, 'install', now() + stateTtlMs);
    res.cookie(INSTALL_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: stateTtlMs,
      path: '/api/studio/github/callback',
    });
    return res.json({ url: options.github.installationUrl(state), method: 'GET', fields: {} });
  });

  router.patch('/github/installations/:id', (req, res) => {
    const installationId = positiveSafeInteger(req.params.id);
    if (!installationId) return res.status(400).json({ error: 'A valid installation id is required.' });
    try {
      const installation = updateGitHubInstallationLabel(installationId, req.body?.label, now());
      if (!installation) return res.status(404).json({ error: 'GitHub installation was not found.' });
      return res.json({ installation });
    } catch {
      return res.status(400).json({ error: 'A valid connection label is required.' });
    }
  });

  router.delete('/github/installations/:id', (req, res) => {
    const installationId = positiveSafeInteger(req.params.id);
    if (!installationId) return res.status(400).json({ error: 'A valid installation id is required.' });
    if (!getGitHubInstallation(installationId)) {
      return res.status(404).json({ error: 'GitHub installation was not found.' });
    }
    const projects = listGitHubInstallationProjects(installationId);
    if (projects.length > 0) {
      return res.status(409).json({
        error: 'Disconnect this GitHub account from its Projects first.',
        code: 'GITHUB_INSTALLATION_IN_USE',
        projects,
      });
    }
    deleteGitHubInstallation(installationId);
    return res.status(204).end();
  });

  router.get('/github/manifest/callback', async (req, res) => {
    const queryState = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = cookieValue(req.headers.cookie, MANIFEST_STATE_COOKIE);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    res.clearCookie(MANIFEST_STATE_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/api/studio/github/manifest/callback',
    });
    if (
      !code
      || !queryState
      || !cookieState
      || cookieState !== queryState
      || !consumeGitHubConnectionState(queryState, 'manifest', now())
    ) {
      return res.status(400).json({ error: 'The GitHub App setup state is invalid or expired.' });
    }
    try {
      await options.github.completeManifest(code);
      const installState = randomBytes(32).toString('base64url');
      createGitHubConnectionState(installState, 'install', now() + stateTtlMs);
      res.cookie(INSTALL_STATE_COOKIE, installState, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        maxAge: stateTtlMs,
        path: '/api/studio/github/callback',
      });
      return res.redirect(302, options.github.installationUrl(installState));
    } catch {
      return res.status(502).json({ error: 'GitHub App setup could not be completed.' });
    }
  });

  router.get('/github/callback', async (req, res) => {
    const queryState = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = cookieValue(req.headers.cookie, INSTALL_STATE_COOKIE);
    const installationId = positiveSafeInteger(req.query.installation_id);
    res.clearCookie(INSTALL_STATE_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/api/studio/github/callback',
    });
    if (
      !queryState
      || !cookieState
      || cookieState !== queryState
      || !installationId
      || !consumeGitHubConnectionState(queryState, 'install', now())
    ) {
      return res.status(400).json({ error: 'The GitHub connection state is invalid or expired.' });
    }
    const oauthState = randomBytes(32).toString('base64url');
    createGitHubConnectionState(oauthState, 'oauth', now() + stateTtlMs, installationId);
    res.cookie(OAUTH_STATE_COOKIE, oauthState, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: stateTtlMs,
      path: '/api/studio/github/oauth/callback',
    });
    // GitHub documents setup-url installation_id as attacker-spoofable. The OAuth
    // callback must prove this installation is visible to the authorizing user.
    return res.redirect(302, options.github.authorizationUrl(oauthState));
  });

  router.get('/github/oauth/callback', async (req, res) => {
    const queryState = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = cookieValue(req.headers.cookie, OAUTH_STATE_COOKIE);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    res.clearCookie(OAUTH_STATE_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/api/studio/github/oauth/callback',
    });
    const connection = queryState && cookieState === queryState
      ? consumeGitHubConnectionState(queryState, 'oauth', now())
      : null;
    if (!code || !connection?.installationId) {
      return res.status(400).json({ error: 'The GitHub authorization state is invalid or expired.' });
    }
    try {
      const installation = await options.github.authorizeInstallation(code, connection.installationId);
      if (installation.id !== connection.installationId) {
        throw new Error('GitHub returned a different installation than the authorized callback.');
      }
      upsertGitHubInstallation(installation, now());
      return res.redirect(302, `/settings?installationId=${installation.id}#github`);
    } catch {
      return res.status(502).json({ error: 'GitHub installation ownership could not be verified.' });
    }
  });

  router.get('/github/repositories', async (req, res) => {
    const installationId = positiveSafeInteger(req.query.installationId);
    if (!installationId || !getGitHubInstallation(installationId)) {
      return res.status(404).json({ error: 'GitHub installation was not found.' });
    }
    try {
      return res.json({ repositories: await options.github.listRepositories(installationId) });
    } catch {
      return res.status(502).json({ error: 'GitHub repositories could not be loaded.' });
    }
  });

  router.get('/projects', (_req, res) => {
    res.json({ projects: listStudioProjects() });
  });

  router.post('/projects', async (req, res) => {
    const installationId = positiveSafeInteger(req.body?.installationId);
    const repositoryId = positiveSafeInteger(req.body?.repositoryId);
    if (!installationId || !repositoryId) {
      return res.status(400).json({ error: 'A valid installationId and repositoryId are required.' });
    }
    if (!getGitHubInstallation(installationId)) {
      return res.status(404).json({ error: 'GitHub installation was not found.' });
    }

    try {
      const repositories = await options.github.listRepositories(installationId);
      const repository = repositories.find((candidate) => candidate.id === repositoryId);
      if (!repository) return res.status(404).json({ error: 'Repository is not available to this GitHub installation.' });
      const result = importGitHubProject(installationId, repository, now());
      return res.status(result.created ? 201 : 200).json({ project: result.project });
    } catch (error) {
      if (error instanceof Error && /permission upgrade/i.test(error.message)) {
        return res.status(409).json({
          error: error.message,
          code: 'GITHUB_PERMISSION_UPGRADE_REQUIRED',
        });
      }
      return res.status(502).json({ error: 'GitHub repository access could not be verified.' });
    }
  });

  return router;
}
