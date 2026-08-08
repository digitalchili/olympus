import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function expandHomePrefix(value: string): string {
  // When OLYMPUS_DISPATCH_HOME is explicitly set, a leading "~/.olympus-dispatch"
  // must resolve against that configured home — not the container/process $HOME,
  // which can differ (e.g. Docker sets HOME=/opt/data/home while Olympus lives at
  // /opt/data/olympus-dispatch). Falling back to $HOME would point the file browser
  // at a path outside its configured browsable roots.
  const configuredOlympusHome = process.env.OLYMPUS_DISPATCH_HOME?.trim();
  if (configuredOlympusHome && value === '~/.olympus-dispatch') {
    return configuredOlympusHome;
  }
  if (configuredOlympusHome && value.startsWith('~/.olympus-dispatch/')) {
    return join(configuredOlympusHome, value.slice('~/.olympus-dispatch/'.length));
  }
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return resolve(expandHomePrefix(value));
}

export function resolveHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.hermes');
}

export function resolveOlympusHome(): string {
  const configured = process.env.OLYMPUS_DISPATCH_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.olympus-dispatch');
}

export function resolveOlympusDataDir(): string {
  return join(resolveOlympusHome(), 'data');
}

export function resolveOlympusLogsDir(): string {
  return join(resolveOlympusHome(), 'logs');
}

export function resolveOlympusBackupsDir(): string {
  return join(resolveOlympusHome(), 'backups');
}

export function resolveOlympusWorkspaceDir(): string {
  return join(resolveOlympusHome(), 'workspace');
}

/** Root for the host-side project-folder picker, falling back to the workspace when it is missing. */
export function resolveProjectRoot(): string {
  const candidate = process.env.OLYMPUS_DISPATCH_PROJECT_ROOT?.trim() || join(homedir(), 'Dev');
  const resolved = resolveHomeAwarePath(candidate);
  return existsSync(resolved) ? resolved : resolveOlympusWorkspaceDir();
}

export function resolveHermesSkillsDir(): string {
  return join(resolveHermesHome(), 'skills');
}

export function resolveOlympusDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return resolveHomeAwarePath(configured);
  return join(resolveOlympusDataDir(), 'olympus-dispatch.db');
}

export function ensureOlympusStateDirs(): void {
  const dbPath = resolveOlympusDbPath();
  mkdirSync(resolveOlympusDataDir(), { recursive: true });
  mkdirSync(resolveOlympusLogsDir(), { recursive: true });
  mkdirSync(resolveOlympusBackupsDir(), { recursive: true });
  mkdirSync(resolveOlympusWorkspaceDir(), { recursive: true });
  mkdirSync(resolveHermesSkillsDir(), { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
}
