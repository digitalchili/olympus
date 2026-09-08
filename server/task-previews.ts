import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import type { Task, TaskAttachment, TaskArtifactPreview, TaskDraftSelection } from '../shared/types.js';
import { resolveOlympusDataDir } from './paths.js';

const STORE_VERSION = 1;
const MAX_MANIFESTS_PER_MESSAGE = 5;
const MAX_DRAFTS_PER_MANIFEST = 3;
const MAX_DRAFTS_PER_MESSAGE = 15;
const MAX_PREVIEWS_PER_TASK = 100;
const MAX_SELECTIONS_PER_TASK = 50;
const MAX_ID_LENGTH = 64;
const MAX_PREVIEW_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_FEEDBACK_LENGTH = 2_000;
const MAX_ARTIFACT_PATH_LENGTH = 1_000;
const MAX_HTML_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 10_000_000;

// Olympus has one live writer. Serialize publication and selection per task so
// concurrent history hydration cannot replace another draft's index update.
const writes = new Map<string, Promise<void>>();
async function withTaskWrite<T>(taskId: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(taskId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(action);
  const settled = result.then(() => undefined, () => undefined);
  writes.set(taskId, settled);
  try { return await result; }
  finally { if (writes.get(taskId) === settled) writes.delete(taskId); }
}

const SIMPLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const STORAGE_NAME_PATTERN = /^[a-f0-9]{48}\.(?:avif|gif|html|jpg|png|webp)$/;

export const TASK_PREVIEW_HTML_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

export class TaskPreviewError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'TaskPreviewError';
  }
}

export interface TaskPreviewPublicationHint {
  previewId: string;
  title: string;
  description?: string;
  groupId?: string;
  groupTitle?: string;
  draftId?: string;
}

export interface TaskPreviewPublicationCandidate extends TaskPreviewPublicationHint {
  path: string;
}

export interface PreviewableTaskArtifact {
  path: string;
  name: string;
  size: number;
  realPath: string;
  handle: FileHandle;
}

interface StoredTaskPreview {
  preview: TaskArtifactPreview;
  storageName: string;
  mimeType: string;
  size: number;
  sourcePath: string;
  sourceKey: string;
  contentHash: string;
  createdAt: number;
}

interface TaskPreviewStore {
  version: 1;
  taskId: string;
  previews: StoredTaskPreview[];
  selections: TaskDraftSelection[];
}

interface DetectedPreviewContent {
  kind: TaskArtifactPreview['kind'];
  mimeType: string;
  extension: 'avif' | 'gif' | 'html' | 'jpg' | 'png' | 'webp';
  bytes: Buffer;
}

export interface OpenPublishedTaskPreview {
  handle: FileHandle;
  bytes: Buffer;
  preview: TaskArtifactPreview;
  mimeType: string;
  size: number;
  realPath: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function taskStoreRoot(): string {
  return join(resolveOlympusDataDir(), 'task-artifact-previews');
}

function taskStorageKey(taskId: string): string {
  return sha256(taskId).slice(0, 32);
}

function taskStoreDir(taskId: string): string {
  return join(taskStoreRoot(), 'tasks', taskStorageKey(taskId));
}

function snapshotsDir(taskId: string): string {
  return join(taskStoreDir(taskId), 'snapshots');
}

function indexPath(taskId: string): string {
  return join(taskStoreDir(taskId), 'index.json');
}

function emptyStore(taskId: string): TaskPreviewStore {
  return { version: STORE_VERSION, taskId, previews: [], selections: [] };
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath);
  return childRelativePath === '' || (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath));
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function cleanBoundedText(value: unknown, field: string, maxLength: number, required: boolean): string | null {
  if (typeof value !== 'string') return required ? null : '';
  const trimmed = value.trim();
  if (required && !trimmed) return null;
  if (trimmed.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

function validSimpleId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH || !SIMPLE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function validatePreviewId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TaskPreviewError(400, 'previewId must be a string', 'INVALID_PREVIEW_ID');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PREVIEW_ID_LENGTH || !PREVIEW_ID_PATTERN.test(trimmed)) {
    throw new TaskPreviewError(400, 'previewId contains invalid characters', 'INVALID_PREVIEW_ID');
  }
  return trimmed;
}

function validateGroupId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TaskPreviewError(400, 'groupId must be a string', 'INVALID_PREVIEW_GROUP_ID');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH || !SIMPLE_ID_PATTERN.test(trimmed)) {
    throw new TaskPreviewError(400, 'groupId contains invalid characters', 'INVALID_PREVIEW_GROUP_ID');
  }
  return trimmed;
}

function cleanFeedback(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new TaskPreviewError(400, 'feedback must be a string', 'INVALID_SELECTION_FEEDBACK');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_FEEDBACK_LENGTH) {
    throw new TaskPreviewError(413, 'feedback is too long', 'SELECTION_FEEDBACK_TOO_LARGE');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed)) {
    throw new TaskPreviewError(400, 'feedback contains invalid control characters', 'INVALID_SELECTION_FEEDBACK');
  }
  return trimmed;
}

function validArtifactPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ARTIFACT_PATH_LENGTH || trimmed.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return trimmed;
}

function manifestPreviewId(groupId: string, draftId: string): string {
  return `${groupId}:${draftId}`;
}

function mediaPreviewId(taskId: string, sourcePath: string): string {
  return `media-${sha256(`${taskId}\0${sourcePath}`).slice(0, 24)}`;
}

function storageName(taskId: string, previewId: string, extension: DetectedPreviewContent['extension']): string {
  return `${sha256(`${taskId}\0${previewId}`).slice(0, 48)}.${extension}`;
}

function validStoredPreview(value: unknown): StoredTaskPreview | null {
  const record = recordValue(value);
  const preview = recordValue(record?.preview);
  if (!record || !preview) return null;
  try {
    const id = validatePreviewId(preview.id);
    const kind = preview.kind === 'image' || preview.kind === 'html' ? preview.kind : null;
    const title = cleanBoundedText(preview.title, 'title', MAX_TITLE_LENGTH, true);
    if (!kind || !title) return null;
    const description = cleanBoundedText(preview.description, 'description', MAX_DESCRIPTION_LENGTH, false) || undefined;
    const groupId = preview.groupId === undefined ? undefined : validSimpleId(preview.groupId) ?? undefined;
    const groupTitle = cleanBoundedText(preview.groupTitle, 'groupTitle', MAX_TITLE_LENGTH, false) || undefined;
    const draftId = preview.draftId === undefined ? undefined : validSimpleId(preview.draftId) ?? undefined;
    const stored: StoredTaskPreview = {
      preview: {
        id,
        kind,
        title,
        ...(description ? { description } : {}),
        ...(groupId ? { groupId } : {}),
        ...(groupTitle ? { groupTitle } : {}),
        ...(draftId ? { draftId } : {}),
      },
      storageName: typeof record.storageName === 'string' && STORAGE_NAME_PATTERN.test(record.storageName) ? record.storageName : '',
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : '',
      size: Number.isSafeInteger(record.size) && (record.size as number) > 0 ? record.size as number : 0,
      sourcePath: typeof record.sourcePath === 'string' ? record.sourcePath : '',
      sourceKey: typeof record.sourceKey === 'string' ? record.sourceKey : '',
      contentHash: typeof record.contentHash === 'string' && /^[a-f0-9]{64}$/.test(record.contentHash) ? record.contentHash : '',
      createdAt: Number.isSafeInteger(record.createdAt) ? record.createdAt as number : 0,
    };
    if (!stored.storageName || !stored.mimeType || !stored.size || !stored.sourceKey || !stored.contentHash || !stored.createdAt) {
      return null;
    }
    if (kind === 'html' && stored.mimeType !== 'text/html; charset=utf-8') return null;
    if (kind === 'image' && !/^image\/(?:avif|gif|jpeg|png|webp)$/.test(stored.mimeType)) return null;
    return stored;
  } catch {
    return null;
  }
}

function validSelection(value: unknown): TaskDraftSelection | null {
  const record = recordValue(value);
  if (!record) return null;
  try {
    const groupId = validateGroupId(record.groupId);
    const previewId = validatePreviewId(record.previewId);
    const title = cleanBoundedText(record.title, 'title', MAX_TITLE_LENGTH, true);
    const feedback = typeof record.feedback === 'string' ? record.feedback : null;
    const prompt = typeof record.prompt === 'string' ? record.prompt : null;
    const selectedAt = Number.isSafeInteger(record.selectedAt) ? record.selectedAt as number : 0;
    if (!title || feedback === null || prompt === null || feedback.length > MAX_FEEDBACK_LENGTH || prompt.length > 3_000 || selectedAt <= 0) return null;
    return { groupId, previewId, title, feedback, selectedAt, prompt };
  } catch {
    return null;
  }
}

async function readStore(taskId: string): Promise<TaskPreviewStore> {
  try {
    const raw = JSON.parse(await readFile(indexPath(taskId), 'utf8')) as unknown;
    const record = recordValue(raw);
    if (!record || record.version !== STORE_VERSION || record.taskId !== taskId) return emptyStore(taskId);
    const previews = Array.isArray(record.previews)
      ? record.previews.map(validStoredPreview).filter((item): item is StoredTaskPreview => item !== null)
      : [];
    const selections = Array.isArray(record.selections)
      ? record.selections.map(validSelection).filter((item): item is TaskDraftSelection => item !== null)
      : [];
    return { version: STORE_VERSION, taskId, previews, selections };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyStore(taskId);
    throw new TaskPreviewError(500, 'Preview history could not be read', 'PREVIEW_STORE_UNAVAILABLE');
  }
}

async function writeStore(store: TaskPreviewStore): Promise<void> {
  const target = indexPath(store.taskId);
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.index.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

function parseManifest(value: unknown): TaskPreviewPublicationCandidate[] {
  const record = recordValue(value);
  if (!record) return [];
  const groupId = validSimpleId(record.id);
  const groupTitle = cleanBoundedText(record.title, 'title', MAX_TITLE_LENGTH, true);
  if (!groupId || !groupTitle || !Array.isArray(record.drafts)) return [];
  if (record.drafts.length < 1 || record.drafts.length > MAX_DRAFTS_PER_MANIFEST) return [];

  const candidates: TaskPreviewPublicationCandidate[] = [];
  const draftIds = new Set<string>();
  for (const rawDraft of record.drafts) {
    const draft = recordValue(rawDraft);
    if (!draft) return [];
    const draftId = validSimpleId(draft.id);
    const title = cleanBoundedText(draft.title, 'title', MAX_TITLE_LENGTH, true);
    const description = cleanBoundedText(draft.description, 'description', MAX_DESCRIPTION_LENGTH, false) || undefined;
    const path = validArtifactPath(draft.path);
    if (!draftId || draftIds.has(draftId) || !title || !path) return [];
    draftIds.add(draftId);
    candidates.push({
      path,
      previewId: manifestPreviewId(groupId, draftId),
      title,
      ...(description ? { description } : {}),
      groupId,
      groupTitle,
      draftId,
    });
  }
  return candidates;
}

export function parseTaskPreviewManifests(content: string): TaskPreviewPublicationCandidate[] {
  const candidates: TaskPreviewPublicationCandidate[] = [];
  const fencePattern = /```[ \t]*olympus-preview(?:[ \t]+json)?[^\r\n]*\r?\n([\s\S]*?)```/gi;
  let manifestCount = 0;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) !== null) {
    if (++manifestCount > MAX_MANIFESTS_PER_MESSAGE) break;
    if (candidates.length >= MAX_DRAFTS_PER_MESSAGE) break;
    let jsonText = match[1].trim();
    jsonText = jsonText.replace(/^json\s*:/i, '').trim();
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      for (const candidate of parseManifest(parsed)) {
        if (candidates.length >= MAX_DRAFTS_PER_MESSAGE) break;
        candidates.push(candidate);
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

function detectImage(bytes: Buffer): Omit<DetectedPreviewContent, 'bytes'> | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { kind: 'image', mimeType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg' };
  }
  const header = bytes.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return { kind: 'image', mimeType: 'image/gif', extension: 'gif' };
  }
  if (bytes.length >= 12 && header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp', extension: 'webp' };
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && bytes.subarray(8, 12).toString('ascii') === 'avif') {
    return { kind: 'image', mimeType: 'image/avif', extension: 'avif' };
  }
  return null;
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function htmlPrototypeAllowed(html: string): boolean {
  if (!/(?:<!doctype\s+html|<html[\s>]|<body[\s>])/i.test(html.slice(0, 2048))) return false;
  if (/<\s*(?:base|form|iframe|frame|frameset|object|embed|applet)\b/i.test(html)) return false;
  if (/<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) return false;
  if (/\b(?:https?|ftp|file|ws|wss):\/\//i.test(html)) return false;
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/i.test(html)) return false;
  if (/@import\b/i.test(html)) return false;
  if (/url\(\s*(?!['"]?data:)/i.test(html)) return false;

  const quotedAttr = /\b(?:src|href|action|formaction|poster|data)\s*=\s*(["'])(.*?)\1/gis;
  let match: RegExpExecArray | null;
  while ((match = quotedAttr.exec(html)) !== null) {
    const value = match[2].trim();
    if (value && !value.startsWith('data:') && !value.startsWith('#')) return false;
  }
  const bareAttr = /\b(?:src|href|action|formaction|poster|data)\s*=\s*([^\s"'=<>`]+)/gi;
  while ((match = bareAttr.exec(html)) !== null) {
    const value = match[1].trim();
    if (value && !value.startsWith('data:') && !value.startsWith('#')) return false;
  }
  return true;
}

async function detectPreviewContent(artifact: PreviewableTaskArtifact): Promise<DetectedPreviewContent | null> {
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) return null;
  if (artifact.size > MAX_IMAGE_BYTES) return null;
  // Keep the workspace-approved descriptor; the pathname may have been replaced.
  const bytes = Buffer.alloc(artifact.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await artifact.handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) return null;
    offset += bytesRead;
  }
  if (bytes.length <= 0 || bytes.length !== artifact.size) return null;

  const image = detectImage(bytes);
  if (image) return { ...image, bytes };

  const extension = extname(artifact.name).toLowerCase();
  if (extension !== '.html' && extension !== '.htm') return null;
  if (artifact.size > MAX_HTML_BYTES) return null;
  const html = decodeUtf8(bytes);
  if (!html || !htmlPrototypeAllowed(html)) return null;
  return { kind: 'html', mimeType: 'text/html; charset=utf-8', extension: 'html', bytes };
}

async function persistSnapshot(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    if (sha256(await readFile(path)) !== sha256(bytes)) {
      throw new TaskPreviewError(409, 'An immutable preview already exists with different content', 'PREVIEW_SNAPSHOT_CHANGED');
    }
  }
}

async function publishTaskArtifactPreviewUnlocked(
  task: Task,
  artifact: PreviewableTaskArtifact,
  hint?: TaskPreviewPublicationHint,
): Promise<TaskArtifactPreview | undefined> {
  const previewId = hint?.previewId ?? mediaPreviewId(task.id, artifact.path);
  validatePreviewId(previewId);
  const store = await readStore(task.id);
  const existing = store.previews.find((item) => item.preview.id === previewId);
  if (existing) return existing.preview;
  if (store.previews.length >= MAX_PREVIEWS_PER_TASK) return undefined;

  const title = cleanBoundedText(hint?.title ?? artifact.name, 'title', MAX_TITLE_LENGTH, true);
  if (!title) return undefined;
  const description = cleanBoundedText(hint?.description, 'description', MAX_DESCRIPTION_LENGTH, false) || undefined;
  const groupId = hint?.groupId ? validSimpleId(hint.groupId) : undefined;
  const groupTitle = hint?.groupTitle ? cleanBoundedText(hint.groupTitle, 'groupTitle', MAX_TITLE_LENGTH, true) ?? undefined : undefined;
  const draftId = hint?.draftId ? validSimpleId(hint.draftId) : undefined;
  if ((hint?.groupId && !groupId) || (hint?.groupTitle && !groupTitle) || (hint?.draftId && !draftId)) return undefined;

  const detected = await detectPreviewContent(artifact);
  if (!detected) return undefined;

  const preview: TaskArtifactPreview = {
    id: previewId,
    kind: detected.kind,
    title,
    ...(description ? { description } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupTitle ? { groupTitle } : {}),
    ...(draftId ? { draftId } : {}),
  };
  const stored: StoredTaskPreview = {
    preview,
    storageName: storageName(task.id, previewId, detected.extension),
    mimeType: detected.mimeType,
    size: detected.bytes.length,
    sourcePath: artifact.path,
    sourceKey: hint ? `manifest:${hint.groupId ?? ''}:${hint.draftId ?? ''}` : `media:${artifact.path}`,
    contentHash: sha256(detected.bytes),
    createdAt: Date.now(),
  };

  await persistSnapshot(join(snapshotsDir(task.id), stored.storageName), detected.bytes);
  store.previews.push(stored);
  await writeStore(store);
  return preview;
}

export function publishTaskArtifactPreview(task: Task, artifact: PreviewableTaskArtifact, hint?: TaskPreviewPublicationHint): Promise<TaskArtifactPreview | undefined> {
  return withTaskWrite(task.id, () => publishTaskArtifactPreviewUnlocked(task, artifact, hint));
}

export async function restoreTaskArtifactPreview(taskId: string, path: string, hint?: TaskPreviewPublicationHint): Promise<TaskAttachment | null> {
  const id = hint?.previewId ?? mediaPreviewId(taskId, path);
  const record = (await readStore(taskId)).previews.find((item) => item.preview.id === id);
  return record ? { path: record.sourcePath, name: basename(record.sourcePath), size: record.size, preview: record.preview } : null;
}

export async function openPublishedTaskPreview(taskId: string, previewId: string): Promise<OpenPublishedTaskPreview> {
  const id = validatePreviewId(previewId);
  const store = await readStore(taskId);
  const record = store.previews.find((item) => item.preview.id === id);
  if (!record) throw new TaskPreviewError(404, 'Preview not found', 'PREVIEW_NOT_FOUND');
  if (!STORAGE_NAME_PATTERN.test(record.storageName)) {
    throw new TaskPreviewError(404, 'Preview not found', 'PREVIEW_NOT_FOUND');
  }

  let root: string;
  let realPath: string;
  try {
    root = await realpath(snapshotsDir(taskId));
    realPath = await realpath(resolve(snapshotsDir(taskId), record.storageName));
  } catch {
    throw new TaskPreviewError(404, 'Preview snapshot not found', 'PREVIEW_NOT_FOUND');
  }
  if (!isSameOrChildPath(root, realPath)) {
    throw new TaskPreviewError(403, 'Preview snapshot is outside storage', 'PREVIEW_OUTSIDE_STORAGE');
  }

  const handle = await open(realPath, fsConstants.O_RDONLY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new TaskPreviewError(404, 'Preview snapshot not found', 'PREVIEW_NOT_FOUND');
    if (stats.size !== record.size) throw new TaskPreviewError(409, 'Preview snapshot changed on disk', 'PREVIEW_SNAPSHOT_CHANGED');
    const bytes = await handle.readFile();
    if (sha256(bytes) !== record.contentHash) throw new TaskPreviewError(409, 'Preview snapshot changed on disk', 'PREVIEW_SNAPSHOT_CHANGED');
    return { handle, bytes, preview: record.preview, mimeType: record.mimeType, size: stats.size, realPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function listTaskDraftSelections(taskId: string): Promise<TaskDraftSelection[]> {
  return (await readStore(taskId)).selections;
}

function buildSelectionPrompt(preview: TaskArtifactPreview, feedback: string): string {
  const group = preview.groupTitle ?? preview.groupId ?? 'design preview';
  const draft = preview.draftId ? `draft ${preview.draftId}` : 'draft';
  const feedbackLine = feedback ? `\nFeedback: ${feedback}` : '';
  return `Continue with the selected design draft "${preview.title}" from "${group}" (${draft}, preview ${preview.id}).${feedbackLine}`;
}

async function saveTaskDraftSelectionUnlocked(taskId: string, input: unknown): Promise<TaskDraftSelection> {
  const body = recordValue(input);
  if (!body) throw new TaskPreviewError(400, 'Request body is required', 'BAD_SELECTION_REQUEST');
  const groupId = validateGroupId(body.groupId);
  const previewId = validatePreviewId(body.previewId);
  const feedback = cleanFeedback(body.feedback);
  const store = await readStore(taskId);
  const record = store.previews.find((item) => (
    item.preview.id === previewId
    && item.preview.groupId === groupId
    && Boolean(item.preview.draftId)
  ));
  if (!record) throw new TaskPreviewError(404, 'Preview draft not found for this task and group', 'PREVIEW_DRAFT_NOT_FOUND');

  const selection: TaskDraftSelection = {
    groupId,
    previewId,
    title: record.preview.title,
    feedback,
    selectedAt: Date.now(),
    prompt: buildSelectionPrompt(record.preview, feedback),
  };
  const selections = [selection, ...store.selections.filter((item) => item.groupId !== groupId)].slice(0, MAX_SELECTIONS_PER_TASK);
  await writeStore({ ...store, selections });
  return selection;
}

export function saveTaskDraftSelection(taskId: string, input: unknown): Promise<TaskDraftSelection> {
  return withTaskWrite(taskId, () => saveTaskDraftSelectionUnlocked(taskId, input));
}
