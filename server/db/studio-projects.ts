import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type {
  StudioGitHubInstallation,
  StudioGitHubRepository,
  StudioProject,
} from '../../shared/types.js';
import db from './index.js';

type InstallationRow = {
  id: number;
  account_login: string;
  account_type: 'User' | 'Organization';
  created_at: number;
  updated_at: number;
};

type ProjectRow = {
  id: string;
  name: string;
  provider: 'github';
  provider_repository_id: number;
  installation_id: number;
  owner: string;
  full_name: string;
  private: number;
  default_branch: string;
  html_url: string;
  clone_url: string;
  mode: 'read_only';
  created_at: number;
  updated_at: number;
};

function installationFromRow(row: InstallationRow): StudioGitHubInstallation {
  return {
    id: row.id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectFromRow(row: ProjectRow): StudioProject {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerRepositoryId: row.provider_repository_id,
    installationId: row.installation_id,
    owner: row.owner,
    fullName: row.full_name,
    private: row.private === 1,
    defaultBranch: row.default_branch,
    htmlUrl: row.html_url,
    cloneUrl: row.clone_url,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function createGitHubConnectionState(
  state: string,
  flow: 'manifest' | 'install' | 'oauth',
  expiresAt: number,
  installationId: number | null = null,
): void {
  db.prepare(`
    INSERT INTO studio_github_connection_states (
      state_hash, flow, installation_id, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, NULL)
  `).run(stateHash(state), flow, installationId, expiresAt);
}

export function consumeGitHubConnectionState(
  state: string,
  flow: 'manifest' | 'install' | 'oauth',
  now: number,
): { installationId: number | null } | null {
  return db.transaction(() => {
    const hash = stateHash(state);
    const row = db.prepare(`
      SELECT installation_id
      FROM studio_github_connection_states
      WHERE state_hash = ? AND flow = ? AND consumed_at IS NULL AND expires_at > ?
    `).get(hash, flow, now) as { installation_id: number | null } | undefined;
    if (!row) return null;
    const result = db.prepare(`
      UPDATE studio_github_connection_states
      SET consumed_at = ?
      WHERE state_hash = ? AND consumed_at IS NULL
    `).run(now, hash);
    return result.changes === 1 ? { installationId: row.installation_id } : null;
  })();
}

export function upsertGitHubInstallation(input: {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
}, now = Date.now()): StudioGitHubInstallation {
  db.prepare(`
    INSERT INTO studio_github_installations (
      id, account_login, account_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      account_login = excluded.account_login,
      account_type = excluded.account_type,
      updated_at = excluded.updated_at
  `).run(input.id, input.accountLogin, input.accountType, now, now);
  return getGitHubInstallation(input.id)!;
}

export function getGitHubInstallation(id: number): StudioGitHubInstallation | undefined {
  const row = db.prepare('SELECT * FROM studio_github_installations WHERE id = ?').get(id) as InstallationRow | undefined;
  return row ? installationFromRow(row) : undefined;
}

export function listGitHubInstallations(): StudioGitHubInstallation[] {
  const rows = db.prepare('SELECT * FROM studio_github_installations ORDER BY updated_at DESC').all() as InstallationRow[];
  return rows.map(installationFromRow);
}

export function listStudioProjects(): StudioProject[] {
  const rows = db.prepare('SELECT * FROM studio_projects ORDER BY updated_at DESC').all() as ProjectRow[];
  return rows.map(projectFromRow);
}

export function importGitHubProject(
  installationId: number,
  repository: StudioGitHubRepository,
  now = Date.now(),
): { project: StudioProject; created: boolean } {
  const existing = db.prepare(`
    SELECT * FROM studio_projects
    WHERE provider = 'github' AND provider_repository_id = ?
  `).get(repository.id) as ProjectRow | undefined;

  if (existing) {
    db.prepare(`
      UPDATE studio_projects SET
        name = ?, installation_id = ?, owner = ?, full_name = ?, private = ?,
        default_branch = ?, html_url = ?, clone_url = ?, updated_at = ?
      WHERE id = ?
    `).run(
      repository.name,
      installationId,
      repository.owner,
      repository.fullName,
      repository.private ? 1 : 0,
      repository.defaultBranch,
      repository.htmlUrl,
      repository.cloneUrl,
      now,
      existing.id,
    );
    const updated = db.prepare('SELECT * FROM studio_projects WHERE id = ?').get(existing.id) as ProjectRow;
    return { project: projectFromRow(updated), created: false };
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO studio_projects (
      id, name, provider, provider_repository_id, installation_id, owner, full_name,
      private, default_branch, html_url, clone_url, mode, created_at, updated_at
    ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, 'read_only', ?, ?)
  `).run(
    id,
    repository.name,
    repository.id,
    installationId,
    repository.owner,
    repository.fullName,
    repository.private ? 1 : 0,
    repository.defaultBranch,
    repository.htmlUrl,
    repository.cloneUrl,
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM studio_projects WHERE id = ?').get(id) as ProjectRow;
  return { project: projectFromRow(row), created: true };
}
