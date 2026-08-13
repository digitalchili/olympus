import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Task } from '../shared/types.js';
import { LocalProfileError, localProfileRegistry, type LocalProfileRegistry, type LocalProfileTarget } from './local-profiles.js';
import { ProfileDeletingError, acquireProfileWork } from './profile-deletion.js';

export const PROFILE_QUERY_PARAM = 'profile';

function queryString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/** Resolve the active workspace once per request instead of parsing profile query parameters in each route. */
export function requestProfile(req: Request, registry: LocalProfileRegistry = localProfileRegistry): LocalProfileTarget {
  const cached = (req as Request & { activeHermesProfile?: LocalProfileTarget }).activeHermesProfile;
  if (cached) return cached;
  const requested = queryString(req.query[PROFILE_QUERY_PARAM]);
  const profile = requested ? registry.requireActive(requested) : registry.default();
  (req as Request & { activeHermesProfile?: LocalProfileTarget }).activeHermesProfile = profile;
  return profile;
}

export function taskBelongsToProfile(task: Task, profile: Pick<LocalProfileTarget, 'id' | 'isDefault'>): boolean {
  const handler = task.handling_profile_id ?? task.profile_name ?? 'default';
  return handler === profile.id;
}

export function requireTaskForProfile(
  getTask: (id: string) => Task | undefined,
  registry: LocalProfileRegistry = localProfileRegistry,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const task = typeof id === 'string' ? getTask(id) : undefined;
      if (!task || !taskBelongsToProfile(task, requestProfile(req, registry))) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.locals.task = task;
      next();
    } catch (error) {
      const profileError = sendProfileError(error);
      if (profileError) {
        res.status(profileError.status).json(profileError.body);
        return;
      }
      res.status(500).json({ error: 'Could not resolve local Hermes profile' });
    }
  };
}

/** Hold profile-scoped requests stable while a profile deletion waits to take its snapshot. */
export function profileRequestGate(
  resolveProfileId: (req: Request, registry: LocalProfileRegistry) => string = (req, registry) => requestProfile(req, registry).id,
  registry: LocalProfileRegistry = localProfileRegistry,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const release = acquireProfileWork(resolveProfileId(req, registry));
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        release();
      };
      res.once('finish', releaseOnce);
      res.once('close', releaseOnce);
      next();
    } catch (error) {
      const profileError = sendProfileError(error);
      if (profileError) {
        res.status(profileError.status).json(profileError.body);
        return;
      }
      res.status(500).json({ error: 'Could not resolve local Hermes profile' });
    }
  };
}

/** Hold task requests stable while a profile deletion waits to take its task snapshot. */
export function profileTaskRequestGate(registry: LocalProfileRegistry = localProfileRegistry): RequestHandler {
  const mutationGate = profileRequestGate((req) => requestProfile(req, registry).id, registry);
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    mutationGate(req, res, next);
  };
}

export function sendProfileError(error: unknown): { status: number; body: { error: string; code: string } } | null {
  if (!(error instanceof LocalProfileError || error instanceof ProfileDeletingError)) return null;
  return { status: error.status, body: { error: error.message, code: error.code } };
}
