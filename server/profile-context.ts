import type { Request } from 'express';
import { LocalProfileError, localProfileRegistry, type LocalProfileRegistry, type LocalProfileTarget } from './local-profiles.js';

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

export function sendProfileError(error: unknown): { status: number; body: { error: string; code: string } } | null {
  if (!(error instanceof LocalProfileError)) return null;
  return { status: error.status, body: { error: error.message, code: error.code } };
}
