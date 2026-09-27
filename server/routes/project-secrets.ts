import { Router, type Request } from 'express';
import { listProjectSecrets, saveProjectSecrets, removeProjectSecret, ProjectSecretsError } from '../db/project-secrets.js';
import { getProject } from '../db/projects.js';
import { getTask } from '../db/queries.js';
import { ProjectAccessError, requireProfileProjectAccess } from '../project-access.js';
import { requestProfile, sendProfileError, taskBelongsToProfile } from '../profile-context.js';
import { localProfileRegistry, type LocalProfileRegistry } from '../local-profiles.js';
import { claimProjectOperation } from '../task-run-lifecycle.js';

function requireSecretEntry(req: Request): void {
  const denied = () => new ProjectSecretsError(403, 'PROJECT_SECRET_ENTRY_REQUIRED', 'Save project secrets using the secure entry in Olympus.');
  // This fences cross-site browser writes; it is not user authentication.
  if (req.get('X-Olympus-Secret-Entry') !== '1' || ['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site') ?? '')) throw denied();
  if (req.get('origin')) {
    try {
      const host = req.get('x-forwarded-host')?.split(',', 1)[0]?.trim() || req.get('host');
      const protocol = req.get('x-forwarded-proto')?.split(',', 1)[0]?.trim() || req.protocol;
      const origin = new URL(req.get('origin')!);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== new URL(`${protocol}://${host}`).origin) throw denied();
    } catch { throw denied(); }
  }
}

export function createProjectSecretsRouter(registry: LocalProfileRegistry = localProfileRegistry): Router {
  const router = Router();
  router.use('/:id/secrets', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!getProject(String(req.params.id))) throw new ProjectAccessError();
      if (req.query.profile !== undefined) requireProfileProjectAccess(String(req.params.id), requestProfile(req, registry).id, req.method === 'GET' ? 'view' : 'manage');
      if (req.method !== 'GET') requireSecretEntry(req);
      next();
    } catch (error) { sendError(res, error); }
  });
  router.get('/:id/secrets', (req, res) => res.json({ secrets: listProjectSecrets(String(req.params.id)) }));
  router.put('/:id/secrets', (req, res) => {
    const projectId = String(req.params.id);
    let release: (() => void) | null = null;
    try {
      release = claimProjectOperation(projectId);
      if (!release) throw new ProjectSecretsError(409, 'PROJECT_OPERATION_ACTIVE', 'The project is being changed. Try saving again when it finishes.');
      if (req.body?.taskId !== undefined) {
        const task = typeof req.body.taskId === 'string' ? getTask(req.body.taskId) : undefined;
        if (!task || (req.query.profile !== undefined && !taskBelongsToProfile(task, requestProfile(req, registry)))) throw new ProjectSecretsError(404, 'TASK_NOT_FOUND', 'Task not found');
        if (task.kind === 'bot' || (task.project_id && task.project_id !== projectId)) throw new ProjectSecretsError(409, 'PROJECT_CHANGED', 'The task’s project changed. Open the current task and save its secrets again.');
      }
      const secrets = saveProjectSecrets(projectId, req.body?.entries);
      return res.json({ secrets, savedNames: (req.body.entries as Array<{ name: string }>).map(entry => entry.name) });
    } catch (error) { return sendError(res, error); }
    finally { release?.(); }
  });
  router.delete('/:id/secrets/:name', (req, res) => {
    const release = claimProjectOperation(String(req.params.id));
    if (!release) return sendError(res, new ProjectSecretsError(409, 'PROJECT_OPERATION_ACTIVE', 'The project is being changed. Try again when it finishes.'));
    try { removeProjectSecret(String(req.params.id), String(req.params.name)); return res.status(204).end(); }
    catch (error) { return sendError(res, error); }
    finally { release(); }
  });
  return router;
}

function sendError(res: import('express').Response, error: unknown) {
  if (error instanceof ProjectSecretsError || error instanceof ProjectAccessError) return res.status(error.status).json({ error: error.message, code: error.code });
  const profileError = sendProfileError(error);
  if (profileError) return res.status(profileError.status).json(profileError.body);
  return res.status(500).json({ error: 'Could not update project secrets. Try again.', code: 'PROJECT_SECRETS_FAILED' });
}
