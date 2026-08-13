import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import type {
  ProjectReference,
  ProjectReferenceChunk,
  ProjectReferenceListItem,
  ProjectReferenceSearchResult,
} from '../../shared/types.js';
import db from './index.js';
import { getProject } from './projects.js';
import { resolveProjectReferencesDir } from '../paths.js';
import { validateOfficeArchive, type ExtractionResult } from '../project-references/extraction-worker.js';

export const PROJECT_REFERENCE_MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED: Record<string, readonly string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain', 'application/octet-stream'],
  '.csv': ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
};

const MIME_ALIASES: Record<string, string> = {
  'application/octet-stream': 'application/octet-stream',
};

type ReferenceRow = {
  id: string;
  project_id: string;
  original_filename: string;
  safe_filename: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  status: ProjectReference['status'];
  error: string | null;
  created_at: number;
  updated_at: number;
  indexed_at: number | null;
  deleted_at: number | null;
};

type ChunkRow = {
  id: string;
  project_id: string;
  reference_id: string;
  version_id: string;
  chunk_index: number;
  text: string;
  page_number: number | null;
  sheet_name: string | null;
  cell_range: string | null;
  created_at: number;
};

function toReference(row: ReferenceRow): ProjectReference {
  return {
    id: row.id,
    projectId: row.project_id,
    originalFilename: row.original_filename,
    safeFilename: row.safe_filename,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
    deletedAt: row.deleted_at,
  };
}

export function publicProjectReference(reference: ProjectReference): ProjectReferenceListItem {
  const { storagePath: _storagePath, ...safe } = reference;
  return safe;
}

function toChunk(row: ChunkRow): ProjectReferenceChunk {
  return {
    id: row.id,
    projectId: row.project_id,
    referenceId: row.reference_id,
    versionId: row.version_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    pageNumber: row.page_number,
    sheetName: row.sheet_name,
    cellRange: row.cell_range,
    createdAt: row.created_at,
  };
}

export function validateProjectReferenceCandidate(input: {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}): { safeFilename: string; extension: string; mimeType: string } {
  const original = input.originalFilename.trim();
  const safeFilename = basename(original);
  if (!original || original !== safeFilename || safeFilename === '.' || safeFilename === '..' || /[\\/]\.\.?($|[\\/])/.test(original)) {
    throw new Error('Project reference requires a safe filename');
  }
  if (safeFilename.length > 180 || /[\u0000-\u001f\u007f]/.test(safeFilename)) {
    throw new Error('Project reference requires a safe filename');
  }
  if (input.sizeBytes <= 0) throw new Error('Project reference is empty');
  if (input.sizeBytes > PROJECT_REFERENCE_MAX_BYTES) throw new Error('Project reference exceeds the size limit');
  const extension = extname(safeFilename).toLocaleLowerCase('en-US');
  const allowed = ALLOWED[extension];
  if (!allowed) throw new Error(`Project reference format ${extension || '(none)'} is not supported`);
  const mimeType = (input.mimeType || 'application/octet-stream').split(';', 1)[0].trim().toLocaleLowerCase('en-US');
  const normalizedMime = MIME_ALIASES[mimeType] ?? mimeType;
  if (!allowed.includes(normalizedMime)) {
    throw new Error(`Project reference MIME type ${mimeType} does not match ${extension}`);
  }
  return { safeFilename, extension, mimeType: normalizedMime };
}

async function validateProjectReferenceContent(path: string, extension: string): Promise<void> {
  if (extension === '.docx' || extension === '.xlsx') {
    await validateOfficeArchive(path, extension);
    return;
  }

  const bytes = await readFile(path);
  const reject = () => {
    throw new Error(`Project reference content does not match ${extension}`);
  };

  if (extension === '.pdf') {
    const header = bytes.subarray(0, Math.min(bytes.length, 1_024)).indexOf(Buffer.from('%PDF-'));
    const trailer = bytes.subarray(Math.max(0, bytes.length - 1_024)).indexOf(Buffer.from('%%EOF'));
    if (header < 0 || trailer < 0) reject();
    return;
  }
  if (extension === '.png') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (
      bytes.length < 32
      || !bytes.subarray(0, 8).equals(signature)
      || bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
      || bytes.indexOf(Buffer.from('IEND')) < 0
    ) reject();
    return;
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let hasStartOfFrame = false;
    for (let index = 2; index + 1 < bytes.length; index += 1) {
      if (bytes[index] === 0xff && startOfFrameMarkers.has(bytes[index + 1])) {
        hasStartOfFrame = true;
        break;
      }
    }
    if (
      bytes.length < 8
      || bytes[0] !== 0xff
      || bytes[1] !== 0xd8
      || bytes[bytes.length - 2] !== 0xff
      || bytes[bytes.length - 1] !== 0xd9
      || !hasStartOfFrame
    ) reject();
    return;
  }
  if (extension === '.txt' || extension === '.md' || extension === '.csv') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      reject();
      return;
    }
    if (text.includes('\u0000')) reject();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolvePromise);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function ensureProjectStorage(projectId: string) {
  const root = resolveProjectReferencesDir();
  const projectRoot = resolve(root, projectId);
  if (!projectRoot.startsWith(resolve(root))) throw new Error('Invalid Project reference storage root');
  const quarantineDir = join(projectRoot, 'quarantine');
  const originalsDir = join(projectRoot, 'originals');
  await mkdir(quarantineDir, { recursive: true });
  await mkdir(originalsDir, { recursive: true });
  return { projectRoot, quarantineDir, originalsDir };
}

async function runExtractionWorker(path: string, extension: string, mimeType: string): Promise<ExtractionResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsWorker = resolve(here, '../project-references/extraction-worker.ts');
  const jsWorker = resolve(here, '../project-references/extraction-worker.js');
  const worker = existsSync(tsWorker) ? tsWorker : jsWorker;
  const child = spawn(process.execPath, [...process.execArgv, worker], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), Number(process.env.OLYMPUS_PROJECT_REFERENCES_EXTRACT_TIMEOUT_MS ?? 15_000));
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(JSON.stringify({ path, extension, mimeType }));
  const code = await new Promise<number | null>((resolvePromise) => child.on('close', resolvePromise));
  clearTimeout(timeout);
  if (code !== 0) throw new Error(Buffer.concat(stderr).toString('utf8') || 'Project reference extraction failed');
  return JSON.parse(Buffer.concat(stdout).toString('utf8')) as ExtractionResult;
}

function replaceChunks(input: {
  projectId: string;
  referenceId: string;
  versionId: string;
  chunks: ExtractionResult['chunks'];
  now: number;
}) {
  db.prepare('DELETE FROM project_reference_chunks_fts WHERE reference_id = ?').run(input.referenceId);
  db.prepare('DELETE FROM project_reference_chunks WHERE reference_id = ?').run(input.referenceId);
  const insertChunk = db.prepare(`
    INSERT INTO project_reference_chunks (
      id, project_id, reference_id, version_id, chunk_index, text, page_number, sheet_name, cell_range, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO project_reference_chunks_fts (chunk_id, project_id, reference_id, text)
    VALUES (?, ?, ?, ?)
  `);
  input.chunks.forEach((chunk, index) => {
    const id = uuid();
    insertChunk.run(
      id,
      input.projectId,
      input.referenceId,
      input.versionId,
      index,
      chunk.text,
      chunk.pageNumber ?? null,
      chunk.sheetName ?? null,
      chunk.cellRange ?? null,
      input.now,
    );
    insertFts.run(id, input.projectId, input.referenceId, chunk.text);
  });
}

export async function createProjectReferenceFromQuarantine(input: {
  projectId: string;
  quarantinePath: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes?: number;
  now?: number;
}): Promise<ProjectReference> {
  if (!getProject(input.projectId)) throw new Error('Project not found');
  const sizeBytes = input.sizeBytes ?? (await stat(input.quarantinePath)).size;
  const candidate = validateProjectReferenceCandidate({
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    sizeBytes,
  });
  await validateProjectReferenceContent(input.quarantinePath, candidate.extension);
  const now = input.now ?? Date.now();
  const sha256 = await sha256File(input.quarantinePath);
  const { originalsDir } = await ensureProjectStorage(input.projectId);
  const storagePath = join(originalsDir, `${sha256}${candidate.extension}`);
  if (existsSync(storagePath)) await rm(input.quarantinePath, { force: true });
  else await rename(input.quarantinePath, storagePath);
  const id = uuid();
  const versionId = uuid();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO project_references (
        id, project_id, original_filename, safe_filename, mime_type, extension, size_bytes, sha256,
        storage_path, status, error, created_at, updated_at, indexed_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracting', NULL, ?, ?, NULL, NULL)
      ON CONFLICT(project_id, sha256) DO UPDATE SET
        status = 'extracting', error = NULL, updated_at = excluded.updated_at, deleted_at = NULL
    `).run(id, input.projectId, candidate.safeFilename, candidate.safeFilename, candidate.mimeType, candidate.extension, sizeBytes, sha256, storagePath, now, now);
    const row = db.prepare('SELECT id FROM project_references WHERE project_id = ? AND sha256 = ?').get(input.projectId, sha256) as { id: string };
    db.prepare(`
      INSERT OR IGNORE INTO project_reference_versions (id, reference_id, sha256, storage_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(versionId, row.id, sha256, storagePath, now);
  })();
  const row = db.prepare('SELECT id FROM project_references WHERE project_id = ? AND sha256 = ?').get(input.projectId, sha256) as { id: string };
  await reindexProjectReference(input.projectId, row.id, now);
  return getProjectReference(input.projectId, row.id)!;
}

export function getProjectReference(projectId: string, referenceId: string): ProjectReference | undefined {
  const row = db.prepare('SELECT * FROM project_references WHERE project_id = ? AND id = ?').get(projectId, referenceId) as ReferenceRow | undefined;
  return row ? toReference(row) : undefined;
}

export function listProjectReferences(projectId: string): ProjectReferenceListItem[] {
  const rows = db.prepare(`
    SELECT * FROM project_references
    WHERE project_id = ? AND status <> 'deleted'
    ORDER BY updated_at DESC, original_filename COLLATE NOCASE
  `).all(projectId) as ReferenceRow[];
  return rows.map((row) => publicProjectReference(toReference(row)));
}

export function listProjectReferenceChunks(projectId: string, referenceId: string): ProjectReferenceChunk[] {
  const rows = db.prepare(`
    SELECT * FROM project_reference_chunks
    WHERE project_id = ? AND reference_id = ?
    ORDER BY chunk_index
  `).all(projectId, referenceId) as ChunkRow[];
  return rows.map(toChunk);
}

export async function reindexProjectReference(projectId: string, referenceId: string, now = Date.now()): Promise<ProjectReference> {
  const reference = getProjectReference(projectId, referenceId);
  if (!reference || reference.status === 'deleted') throw new Error('Project reference not found');
  const version = db.prepare(`
    SELECT id FROM project_reference_versions WHERE reference_id = ? AND sha256 = ?
  `).get(reference.id, reference.sha256) as { id: string } | undefined;
  if (!version) throw new Error('Project reference version not found');
  db.prepare("UPDATE project_references SET status = 'extracting', error = NULL, updated_at = ? WHERE id = ?").run(now, reference.id);
  try {
    const extracted = await runExtractionWorker(reference.storagePath, reference.extension, reference.mimeType);
    const error = extracted.warnings.length ? extracted.warnings.join(' ') : null;
    db.transaction(() => {
      replaceChunks({ projectId, referenceId: reference.id, versionId: version.id, chunks: extracted.chunks, now });
      db.prepare(`
        UPDATE project_references
        SET status = 'indexed', error = ?, updated_at = ?, indexed_at = ?
        WHERE id = ?
      `).run(error, now, now, reference.id);
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project reference extraction failed';
    db.prepare("UPDATE project_references SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message.slice(0, 1_000), now, reference.id);
  }
  return getProjectReference(projectId, reference.id)!;
}

export function searchProjectReferences(projectId: string, query: string, limit = 10): ProjectReferenceSearchResult[] {
  const term = query.trim();
  if (!term) return [];
  const expression = `"${term.replace(/"/g, '""')}"`;
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const rows = db.prepare(`
    SELECT f.chunk_id, f.reference_id, snippet(project_reference_chunks_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet,
      c.chunk_index, c.page_number, c.sheet_name, c.cell_range, r.original_filename
    FROM project_reference_chunks_fts f
    JOIN project_reference_chunks c ON c.id = f.chunk_id
    JOIN project_references r ON r.id = f.reference_id
    WHERE project_reference_chunks_fts MATCH ? AND f.project_id = ? AND r.status = 'indexed'
    ORDER BY rank
    LIMIT ?
  `).all(expression, projectId, safeLimit) as Array<{
    chunk_id: string;
    reference_id: string;
    snippet: string;
    chunk_index: number;
    page_number: number | null;
    sheet_name: string | null;
    cell_range: string | null;
    original_filename: string;
  }>;
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    referenceId: row.reference_id,
    snippet: row.snippet,
    citation: {
      referenceId: row.reference_id,
      originalFilename: row.original_filename,
      chunkIndex: row.chunk_index,
      pageNumber: row.page_number,
      sheetName: row.sheet_name,
      cellRange: row.cell_range,
    },
  }));
}

export function deleteProjectReference(projectId: string, referenceId: string, now = Date.now()): void {
  const reference = getProjectReference(projectId, referenceId);
  if (!reference) throw new Error('Project reference not found');
  db.transaction(() => {
    db.prepare('DELETE FROM project_reference_chunks_fts WHERE reference_id = ?').run(referenceId);
    db.prepare(`
      UPDATE project_references
      SET status = 'deleted', deleted_at = ?, updated_at = ?
      WHERE project_id = ? AND id = ?
    `).run(now, now, projectId, referenceId);
  })();
}
