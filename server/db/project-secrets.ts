import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateProjectSecretEntries, type ProjectSecretEntry, type ProjectSecretMetadata } from '../../shared/project-secrets.js';
import { resolveOlympusDataDir } from '../paths.js';
import db from './index.js';
import { getProject } from './projects.js';

export class ProjectSecretsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const unavailable = () => new ProjectSecretsError(503, 'PROJECT_SECRETS_UNAVAILABLE', 'Project secrets are unavailable. Restore the original private encryption key with the database backup.');
const invalid = (message: string) => new ProjectSecretsError(400, 'INVALID_PROJECT_SECRETS', message);

function key(allowCreate: boolean): Buffer {
  let descriptor: number | undefined;
  try {
    const directory = resolveOlympusDataDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    const uid = process.getuid?.();
    if (!parent.isDirectory() || parent.isSymbolicLink() || (uid !== undefined && parent.uid !== uid)) throw unavailable();
    const path = join(directory, 'project-secrets.key');
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowCreate
          || db.prepare('SELECT 1 FROM project_secrets LIMIT 1').get()) throw unavailable();
      const generated = randomBytes(32);
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, generated);
      fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      const parentFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size !== 32 || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)) throw unavailable();
    return readFileSync(descriptor);
  } catch { throw unavailable(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function encrypt(projectId: string, entry: ProjectSecretEntry, master: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master, nonce);
  cipher.setAAD(Buffer.from(`${projectId}\0${entry.name}`));
  const encrypted = Buffer.concat([cipher.update(entry.value, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function listProjectSecrets(projectId: string): ProjectSecretMetadata[] {
  return db.prepare('SELECT name, updated_at AS updatedAt FROM project_secrets WHERE project_id = ? ORDER BY name').all(projectId) as ProjectSecretMetadata[];
}

export function saveProjectSecrets(projectId: string, input: unknown): ProjectSecretMetadata[] {
  let entries: ProjectSecretEntry[];
  try { entries = validateProjectSecretEntries(input); }
  catch (error) { throw invalid((error as Error).message); }
  if (!getProject(projectId)) throw new ProjectSecretsError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  const master = key(true);
  db.transaction(() => {
    if (new Set([...listProjectSecrets(projectId).map(secret => secret.name), ...entries.map(secret => secret.name)]).size > 64) throw invalid('Each project can store at most 64 secrets.');
    const save = db.prepare(`INSERT INTO project_secrets (project_id, name, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, name) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at`);
    const now = Date.now();
    for (const entry of entries) save.run(projectId, entry.name, encrypt(projectId, entry, master), now, now);
  })();
  return listProjectSecrets(projectId);
}

/** Internal execution boundary only. Never expose this through HTTP or worker protocol. */
export function getProjectSecretValues(projectId: string, names: string[]): Record<string, string> {
  try { validateProjectSecretEntries(Array.isArray(names) ? names.map(name => ({ name, value: 'validation' })) : names); }
  catch (error) { throw invalid((error as Error).message); }
  const rows = names.map(name => {
    const row = db.prepare('SELECT encrypted_value FROM project_secrets WHERE project_id = ? AND name = ?').get(projectId, name) as { encrypted_value: string } | undefined;
    if (!row) throw new ProjectSecretsError(404, 'PROJECT_SECRET_NOT_FOUND', 'A requested project secret is not available. Check Project Settings.');
    return { name, payload: row.encrypted_value };
  });
  const master = key(false);
  const result: Record<string, string> = {};
  try {
    for (const { name, payload } of rows) {
      const [version, nonce, tag, ciphertext, extra] = payload.split('.');
      if (version !== 'v1' || !nonce || !tag || !ciphertext || extra !== undefined) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(nonce, 'base64url'));
      decipher.setAAD(Buffer.from(`${projectId}\0${name}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      result[name] = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    }
  } catch { throw unavailable(); }
  return result;
}

export function removeProjectSecret(projectId: string, name: string): void {
  db.prepare('DELETE FROM project_secrets WHERE project_id = ? AND name = ?').run(projectId, name);
}
