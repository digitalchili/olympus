import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { StudioGitHubRepository } from '../../shared/types.js';
import {
  consumeGitHubConnectionState,
  createGitHubConnectionState,
  getGitHubInstallation,
  importGitHubProject,
  listGitHubInstallations,
  listStudioProjects,
  upsertGitHubInstallation,
} from '../db/studio-projects.js';

export interface StudioGitHubGateway {
  configured: boolean;
  installationUrl(state: string): string;
  authorizationUrl(state: string): string;
  authorizeInstallation(code: string, installationId: number): Promise<{
    id: number;
    accountLogin: string;
    accountType: 'User' | 'Organization';
  }>;
  listRepositories(installationId: number): Promise<StudioGitHubRepository[]>;
}

interface StudioRouterOptions {
  github: StudioGitHubGateway;
  stateTtlMs?: number;
  now?: () => number;
  secureCookies?: boolean;
}

const INSTALL_STATE_COOKIE = 'studio_github_install_state';

function positiveSafeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
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

  router.post('/github/connect', (_req, res) => {
    if (!options.github.configured) {
      return res.status(503).json({ error: 'The Studio GitHub App is not configured.' });
    }
    const state = randomBytes(32).toString('base64url');
    createGitHubConnectionState(state, 'install', now() + stateTtlMs);
    res.cookie(INSTALL_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: stateTtlMs,
      path: '/api/studio/github/callback',
    });
    return res.json({ url: options.github.installationUrl(state) });
  });

  router.get('/github/callback', async (req, res) => {
    const queryState = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = cookieValue(req.headers.cookie, INSTALL_STATE_COOKIE);
    const state = cookieState || queryState;
    const installationId = positiveSafeInteger(req.query.installation_id);
    res.clearCookie(INSTALL_STATE_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/api/studio/github/callback',
    });
    if (
      !state
      || (cookieState && queryState && cookieState !== queryState)
      || !installationId
      || !consumeGitHubConnectionState(state, 'install', now())
    ) {
      return res.status(400).json({ error: 'The GitHub connection state is invalid or expired.' });
    }
    const oauthState = randomBytes(32).toString('base64url');
    createGitHubConnectionState(oauthState, 'oauth', now() + stateTtlMs, installationId);
    // GitHub documents setup-url installation_id as attacker-spoofable. The OAuth
    // callback must prove this installation is visible to the authorizing user.
    return res.redirect(302, options.github.authorizationUrl(oauthState));
  });

  router.get('/github/oauth/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const connection = state ? consumeGitHubConnectionState(state, 'oauth', now()) : null;
    if (!code || !connection?.installationId) {
      return res.status(400).json({ error: 'The GitHub authorization state is invalid or expired.' });
    }
    try {
      const installation = await options.github.authorizeInstallation(code, connection.installationId);
      if (installation.id !== connection.installationId) {
        throw new Error('GitHub returned a different installation than the authorized callback.');
      }
      upsertGitHubInstallation(installation, now());
      return res.redirect(302, `/studio?installationId=${installation.id}`);
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
    } catch {
      return res.status(502).json({ error: 'GitHub repository access could not be verified.' });
    }
  });

  return router;
}
