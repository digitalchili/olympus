import { DEFAULT_PROFILE_NAME } from '@shared/types';
import type { To } from 'react-router';

export const PROFILE_QUERY_PARAM = 'profile';

export function profileIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(PROFILE_QUERY_PARAM)?.trim();
  return value || null;
}

export function searchWithProfile(search: string, profileId: string): string {
  const params = new URLSearchParams(search);
  params.set(PROFILE_QUERY_PARAM, profileId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function pathWithProfile(path: string, profileId: string, preserveExisting = false): string {
  const hashIndex = path.indexOf('#');
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = queryIndex >= 0 ? withoutHash.slice(queryIndex) : '';
  const existingProfile = profileIdFromSearch(search);
  return `${pathname}${preserveExisting && existingProfile ? search : searchWithProfile(search, profileId)}${hash}`;
}

export function toWithProfile(to: To, profileId: string): To {
  if (typeof to === 'string') return pathWithProfile(to, profileId);
  return { ...to, search: searchWithProfile(to.search ?? '', profileId) };
}

export function activeProfileIdFromWindow(): string {
  if (typeof window === 'undefined') return DEFAULT_PROFILE_NAME;
  return profileIdFromSearch(window.location.search) ?? DEFAULT_PROFILE_NAME;
}

export function apiPathWithProfile(path: string, profileId = activeProfileIdFromWindow()): string {
  return pathWithProfile(path, profileId, true);
}
