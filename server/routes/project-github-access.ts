import { Router } from 'express';
import { getProject } from '../db/projects.js';
import { getProjectGitHubInstallationIds, setProjectGitHubInstallationIds } from '../db/project-github-access.js';
import { listGitHubInstallations } from '../db/studio-projects.js';
import { requireProfileProjectAccess, ProjectAccessError } from '../project-access.js';
import { requestProfile, sendProfileError } from '../profile-context.js';
import { localProfileRegistry, type LocalProfileRegistry } from '../local-profiles.js';
import type { StudioGitHubGateway } from './studio.js';

export function createProjectGitHubAccessRouter(github: StudioGitHubGateway, registry: LocalProfileRegistry = localProfileRegistry): Router {
  const router = Router();
  router.route('/:id/github-access').all((req, res, next) => {
    try {
      const projectId = String(req.params.id);
      if (!getProject(projectId)) throw new ProjectAccessError();
      requireProfileProjectAccess(projectId, requestProfile(req, registry).id, req.method === 'GET' ? 'view' : 'manage');
      next();
    } catch (error) {
      const profileError = sendProfileError(error);
      if (profileError) return res.status(profileError.status).json(profileError.body);
      res.status(404).json({ error: 'Project not found' });
    }
  }).get((req, res) => {
    res.json({ installationIds: getProjectGitHubInstallationIds(String(req.params.id)), accounts: listGitHubInstallations() });
  }).put(async (req, res) => {
    const ids: unknown = req.body?.installationIds;
    const accounts = listGitHubInstallations();
    if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || !accounts.some(account => account.id === id))) {
      return res.status(400).json({ error: 'Select connected GitHub accounts.' });
    }
    try {
      if (ids.length && !github.configured) throw new Error('unavailable');
      for (const id of new Set(ids as number[])) await github.listRepositories(id, { readOnly: true });
    } catch {
      return res.status(403).json({ error: 'Could not verify a selected GitHub account. Check its repository access in GitHub settings and try again.' });
    }
    // Authorization and connections can change while GitHub responds.
    try {
      const projectId = String(req.params.id);
      requireProfileProjectAccess(projectId, requestProfile(req, registry).id, 'manage');
      setProjectGitHubInstallationIds(projectId, ids as number[]);
      return res.json({ installationIds: getProjectGitHubInstallationIds(projectId), accounts: listGitHubInstallations() });
    } catch {
      return res.status(409).json({ error: 'Project or GitHub access changed. Reload and try again.' });
    }
  });
  return router;
}
