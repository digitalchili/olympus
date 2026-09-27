import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Task } from '../shared/types.js';
import db from './db/index.js';
import { getAllTasks } from './db/queries.js';
import { getProject } from './db/projects.js';
import { getProjectCleanupReceipt, listPendingProjectDeletions, removeProjectCleanupReceipt, type ProjectCleanupPath } from './db/project-cleanup.js';
import { localProfileRegistry, type LocalProfileRegistry } from './local-profiles.js';
import { resolveOlympusDataDir, resolveProjectReferencesDir } from './paths.js';
import { taskPreviewStorageDir, withTaskPreviewCleanup } from './task-previews.js';
import { claimProjectConfigurationOperation } from './task-run-lifecycle.js';

export class ProjectStorageError extends Error {
  constructor(readonly code: 'PROJECT_STORAGE_UNSAFE' | 'PROJECT_STORAGE_SHARED' | 'PROJECT_CLEANUP_PENDING', message: string) { super(message); }
}

const unsafe = () => new ProjectStorageError('PROJECT_STORAGE_UNSAFE', 'A Project storage folder has an unsafe path. Its files and Project have been preserved.');
function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw unsafe();
}
function baselineName(projectId: string, name: string): boolean {
  return name.startsWith(`${projectId}-`) && /^[a-f0-9]{24}$/.test(name.slice(projectId.length + 1));
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

/** Selected storage roots may be relocated; managed descendants must never follow links. */
async function safeTarget(anchor: string, path: string): Promise<string> {
  if (!inside(anchor, path) || resolve(anchor) === resolve(path)) throw unsafe();
  let current = resolve(anchor);
  for (const part of ['', ...relative(anchor, dirname(path)).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const entry = await info(current);
    if (!entry) return path;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafe();
  }
  return path;
}

function descriptorTarget(projectId: string, path: ProjectCleanupPath, registry: LocalProfileRegistry): { anchor: string; path: string } {
  safeId(projectId);
  const data = resolveOlympusDataDir();
  const checkouts = join(data, 'project-checkouts');
  switch (path.kind) {
    case 'task-checkouts': return { anchor: data, path: join(checkouts, 'tasks', projectId) };
    case 'legacy-checkout':
      if (['tasks', 'baselines'].includes(projectId)) throw unsafe();
      return { anchor: data, path: join(checkouts, projectId) };
    case 'references': return { anchor: data, path: join(resolveProjectReferencesDir(), projectId) };
    case 'baseline':
      if (!baselineName(projectId, path.name)) throw unsafe();
      return { anchor: data, path: join(checkouts, 'baselines', path.name) };
    case 'task-workspace': {
      safeId(path.taskId); safeId(path.profileId);
      const profile = registry.get(path.profileId);
      if (!profile) throw unsafe();
      return { anchor: profile.workspaceDir, path: join(profile.workspaceDir, 'tasks', path.taskId) };
    }
    case 'task-previews':
      safeId(path.taskId);
      return { anchor: data, path: taskPreviewStorageDir(path.taskId) };
    default: throw unsafe();
  }
}

async function assertUnshared(projectId: string, candidates: string[]): Promise<void> {
  const otherTasks = getAllTasks(undefined, true).filter(task => task.project_id !== projectId);
  const otherEditors = db.prepare(`SELECT lease.workdir FROM project_editor_leases lease
    LEFT JOIN tasks task ON task.id = lease.task_id
    WHERE lease.project_id <> ? AND (lease.status = 'active' OR task.workdir = lease.workdir)`).all(projectId) as Array<{ workdir: string }>;
  const retained = [...otherTasks.map(task => task.workdir), ...otherEditors.map(editor => editor.workdir)].filter((path): path is string => Boolean(path));
  const realRetained = await Promise.all(retained.map(path => canonicalPath(resolve(path))));
  for (const path of candidates) {
    const entry = await info(path);
    if (!entry) continue;
    const shared = () => new ProjectStorageError('PROJECT_STORAGE_SHARED', 'A Project folder is also used by another task. Move that task to another folder before deleting this Project.');
    if (retained.some(other => inside(path, resolve(other)) || inside(resolve(other), path))) throw shared();
    // Removing a leaf symlink only unlinks it; its target is never a deletion root.
    if (entry.isSymbolicLink()) continue;
    const physical = await canonicalPath(path);
    if (realRetained.some(other => inside(physical, other) || inside(other, physical))) {
      throw shared();
    }
  }
}

async function checkedTargets(projectId: string, paths: ProjectCleanupPath[], registry: LocalProfileRegistry): Promise<string[]> {
  const targets = await Promise.all(paths.map(async descriptor => {
    const target = descriptorTarget(projectId, descriptor, registry);
    if (descriptor.rootPath && descriptor.rootPath !== resolve(target.anchor)) throw unsafe();
    if (descriptor.rootRealPath && descriptor.rootRealPath !== await canonicalPath(target.anchor)) throw unsafe();
    return safeTarget(target.anchor, target.path);
  }));
  await assertUnshared(projectId, targets);
  return targets;
}

export async function prepareProjectDeletionCleanup(projectId: string, tasks: Task[], registry = localProfileRegistry): Promise<ProjectCleanupPath[]> {
  safeId(projectId);
  const paths: ProjectCleanupPath[] = [{ kind: 'task-checkouts' }, { kind: 'legacy-checkout' }, { kind: 'references' }];
  const baselines = join(resolveOlympusDataDir(), 'project-checkouts', 'baselines');
  await safeTarget(resolveOlympusDataDir(), join(baselines, 'probe'));
  const names = await readdir(baselines).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names) if (baselineName(projectId, name)) paths.push({ kind: 'baseline', name });
  for (const task of tasks) {
    for (const profileId of new Set([task.profile_name ?? 'default', task.handling_profile_id ?? task.profile_name ?? 'default'])) {
      paths.push({ kind: 'task-workspace', taskId: task.id, profileId });
    }
    paths.push({ kind: 'task-previews', taskId: task.id });
  }
  const bound = await Promise.all(paths.map(async descriptor => {
    const { anchor } = descriptorTarget(projectId, descriptor, registry);
    return { ...descriptor, rootPath: resolve(anchor), rootRealPath: await canonicalPath(anchor) };
  }));
  await checkedTargets(projectId, bound, registry);
  return bound;
}

export async function finishProjectDeletionCleanup(projectId: string, registry = localProfileRegistry): Promise<void> {
  const receipt = getProjectCleanupReceipt(projectId);
  if (!receipt) return;
  try {
    if (getProject(projectId)) throw unsafe();
    const taskIds = receipt.paths.filter((path): path is Extract<ProjectCleanupPath, { kind: 'task-previews' }> => path.kind === 'task-previews').map(path => path.taskId);
    await withTaskPreviewCleanup(taskIds, async () => {
      const targets = await checkedTargets(projectId, receipt.paths, registry);
      for (const target of targets) await rm(target, { recursive: true, force: true });
    });
    removeProjectCleanupReceipt(projectId);
  } catch {
    throw new ProjectStorageError('PROJECT_CLEANUP_PENDING', 'The Project and its tasks were deleted, but some local files could not be removed. Retry Delete to finish freeing storage.');
  }
}

/** One startup sweep; unfinished receipts stay visible for an operator retry. */
export async function retryPendingProjectDeletionCleanup(registry = localProfileRegistry): Promise<void> {
  for (const { id } of listPendingProjectDeletions()) {
    const release = claimProjectConfigurationOperation(id);
    if (!release) continue;
    try { await finishProjectDeletionCleanup(id, registry); }
    catch { /* Keep the receipt; no raw filesystem paths are logged. */ }
    finally { release(); }
  }
}
