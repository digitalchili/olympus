import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectEditorLease, ProjectRepositoryLink, ProjectVersion, ProjectGitStatus, PendingProjectPublication } from '../shared/types.js';
import {
  acquireProjectEditor,
  getLatestProjectEditorForTask,
  getProjectEditorForTask,
  getProjectVersion,
  listProjectVersions,
  releaseProjectEditor,
  reactivateProjectEditor,
  advanceProjectEditorBaseline,
} from './db/project-cp.js';
import { getProjectRepositoryLink } from './db/projects.js';
import { recordProjectSyncEvidence } from './db/project-sync.js';
import { createProjectPublication, getProjectPublication, getPendingProjectPublication, setProjectPublicationCommit, confirmProjectPublication, abandonProjectPublication, markProjectPublicationBranchAdvanced, type ProjectPublication } from './db/project-publications.js';
import { buildProjectGitEnv, parseProjectGitConfig, validateProjectGitTransportConfig, ProjectGitError } from './project-git-auth.js';
import { getTask, updateTask } from './db/queries.js';
import { GitHubPermissionUpgradeError } from './studio/github-permissions.js';

const execFile = promisify(execFileCallback);
const MAX_DIFF_BYTES = 60_000;
const MAX_CHANGED_FILES = 200;
const EMPTY_REPOSITORY_BASE = 'olympus.emptyRepositoryBase';

type GitRunResult = { stdout: string; stderr: string };
export type GitRunner = (cwd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => Promise<GitRunResult>;
export type InstallationTokenProvider = (installationId: number, scope: { repositoryId: number; readOnly: boolean }) => Promise<string>;
export type { ProjectGitStatus } from '../shared/types.js';

function publicPublication(row: ProjectPublication): PendingProjectPublication {
  return { id: row.id, action: row.action, commitSha: row.commitSha, ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    targetBranches: row.refs.map(ref => ref.ref.slice('refs/heads/'.length)), state: row.state === 'prepared' ? 'prepared' : 'pending' };
}
export class ProjectPublicationError extends Error {
  readonly statusCode: number;
  readonly pendingPublication: PendingProjectPublication | null;
  constructor(public readonly code: 'PUBLICATION_PENDING' | 'PUBLICATION_UNCONFIRMED' | 'PUBLICATION_CONFLICT', row?: ProjectPublication) {
    super(code === 'PUBLICATION_PENDING' ? 'A saved publication is pending. Resume it or stop retrying before publishing another change.'
      : code === 'PUBLICATION_CONFLICT' ? (row?.failureReason === 'branch_advanced'
        ? 'A GitHub branch has advanced. Stop retrying this saved publication, then merge the latest target branch into the task, run checks, and publish again. Your commit and files are preserved.'
        : 'The saved publication conflicts with the current repository state. Your commit and files are preserved.')
      : 'GitHub publication could not be confirmed. Resume the saved publication; your commit and files are preserved.');
    this.statusCode = code === 'PUBLICATION_UNCONFIRMED' ? 503 : 409;
    this.pendingPublication = row ? publicPublication(row) : null;
  }
}
interface PublicationInput { projectId: string; taskId: string; publicationId: string; repositoryLink: ProjectRepositoryLink; tokenProvider?: InstallationTokenProvider }

export interface PrepareProjectTaskInput {
  projectId: string;
  taskId: string;
  profileId: string;
  repositoryLink: ProjectRepositoryLink;
  tokenProvider?: InstallationTokenProvider;
}

export class ProjectRepositoryBusyError extends Error {
  constructor(
    public readonly activeTaskId: string,
    public readonly activeTaskTitle: string,
    public readonly reason: 'changes' | 'editor',
    public readonly activeTaskProfileId: string,
  ) {
    super(reason === 'changes'
      ? `This Project still has saved changes from “${activeTaskTitle}”. Open that task to review and publish its changes, then retry.`
      : `“${activeTaskTitle}” still has the Project editor reserved. Open that task, or release its editor from the Project page, then retry.`);
  }
}

export class ProjectRepositoryMergeConflictError extends Error {
  constructor(public readonly conflictingFiles: string[], public readonly activeTaskId?: string) {
    const files = conflictingFiles.slice(0, 8).map(file => JSON.stringify(file)).join(', ');
    super(`This Project branch conflicts with the latest GitHub changes in ${files}${conflictingFiles.length > 8 ? ', …' : ''}. Existing work is preserved. ${activeTaskId ? 'Open the previous editor task to resolve the conflicting changes, then retry this task.' : 'Resolve the conflicting changes in the Project checkout, then sync again.'}`);
  }
}

export class ProjectRepositoryCheckpointError extends Error {
  constructor(public readonly activeTaskId: string) {
    super('Synchronizing this Project created a local merge checkpoint. Open the previous editor task and use Commit & Push, then retry this task. Existing work and editor ownership are preserved.');
  }
}

export interface ProjectCpSyncResult {
  updated: boolean;
  currentSha: string;
  message: string;
}

export interface ProjectCpService {
  acquireEditor(input: PrepareProjectTaskInput): Promise<ProjectEditorLease>;
  prepareTask(input: PrepareProjectTaskInput): Promise<ProjectEditorLease>;
  updateTaskSource(input: PrepareProjectTaskInput): Promise<ProjectCpSyncResult>;
  releaseEditor(input: { projectId: string; taskId: string }): Promise<ProjectEditorLease>;
  status(input: { projectId: string; taskId: string }): Promise<ProjectGitStatus>;
  commitPush(input: {
    projectId: string;
    taskId: string;
    repositoryLink: ProjectRepositoryLink;
    message: string;
    tokenProvider?: InstallationTokenProvider;
    deployToDefaultBranch?: boolean;
  }): Promise<ProjectVersion>;
  retryPublication(input: PublicationInput): Promise<ProjectVersion>;
  abandonPublication(input: { projectId: string; taskId: string; publicationId: string }): Promise<void>;
  revert(input: { projectId: string; taskId: string; repositoryLink: ProjectRepositoryLink; versionId: string; tokenProvider?: InstallationTokenProvider }): Promise<ProjectVersion>;
  sync(input: {
    projectId: string;
    repositoryLink: ProjectRepositoryLink;
    tokenProvider?: InstallationTokenProvider;
    releaseEditorLeaseId?: string;
  }): Promise<ProjectCpSyncResult>;
}

interface ProjectCpServiceOptions {
  rootDir: string;
  now?: () => number;
  gitRunner?: GitRunner;
}

const defaultGitRunner: GitRunner = async (cwd, args, options) => {
  const result = await execFile('git', args, {
    cwd,
    env: options?.env ?? buildProjectGitEnv({ baseEnv: process.env, cloneUrl: '' }),
    maxBuffer: 5 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function safeBranchPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

function generatedBranch(projectId: string): string {
  return `olympus/${safeBranchPart(projectId)}-${randomBytes(3).toString('hex')}`;
}

function validateCommitMessage(value: string): string {
  const message = value.trim();
  if (!message) throw new Error('Commit message is required');
  if (message.length > 200) throw new Error('Commit message is too long');
  if (/\p{Cc}/u.test(message)) throw new Error('Commit message contains invalid control characters');
  return message;
}

function bounded(value: string, max = MAX_DIFF_BYTES): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… truncated …`;
}

function changedFilesFromPorcelain(stdout: string): string[] {
  const files: string[] = [];
  const entries = stdout.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const path = entry.slice(3);
    if (path) files.push(path);
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const originalPath = entries[index + 1];
      if (originalPath) files.push(originalPath);
      index += 1;
    }
  }
  return [...new Set(files)].slice(0, MAX_CHANGED_FILES);
}

async function tokenFor(link: ProjectRepositoryLink, tokenProvider: InstallationTokenProvider | undefined, readOnly: boolean): Promise<string | undefined> {
  if (!tokenProvider || !/^https:\/\/github\.com\//i.test(link.cloneUrl)) return undefined;
  try { return await tokenProvider(link.installationId, { repositoryId: link.providerRepositoryId, readOnly }); }
  catch (error) {
    if (error instanceof GitHubPermissionUpgradeError) throw error;
    throw new ProjectGitError();
  }
}

async function ensureIdentity(git: GitRunner, workdir: string): Promise<void> {
  await git(workdir, ['config', 'user.name', 'Olympus Dispatch']);
  await git(workdir, ['config', 'user.email', 'olympus-dispatch@example.invalid']);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Managed Project checkout cannot be a symbolic link');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function managedWorkdir(rootDir: string, ...parts: string[]): string {
  const root = resolve(rootDir);
  if (parts.some(part => !part || part === '.' || part === '..' || /[/\\]/.test(part))) throw new Error('Invalid managed Project checkout path');
  const workdir = resolve(root, ...parts);
  if (!workdir.startsWith(`${root}${sep}`)) throw new Error('Invalid managed Project checkout path');
  return workdir;
}

export function projectBaselineWorkdir(rootDir: string, projectId: string, link: ProjectRepositoryLink): string {
  const sourceKey = createHash('sha256').update(JSON.stringify([
    link.installationId, link.providerRepositoryId, link.cloneUrl, link.defaultBranch,
  ])).digest('hex').slice(0, 24);
  return managedWorkdir(rootDir, 'baselines', `${projectId}-${sourceKey}`);
}

export function createProjectCpService(options: ProjectCpServiceOptions): ProjectCpService {
  const rawGit = options.gitRunner ?? defaultGitRunner;
  const git: GitRunner = async (cwd, args, runOptions) => {
    try { return await rawGit(cwd, args, { env: runOptions?.env ?? buildProjectGitEnv({ baseEnv: process.env, cloneUrl: '' }) }); }
    catch (error) {
      if (error instanceof Error && /refusing to allow a GitHub App to create or update workflow .*without [`']?workflows[`']? permission/i.test(error.message)) throw new GitHubPermissionUpgradeError();
      // Classify Git's machine-readable rejection, but never retain raw output
      // (which may contain credentials or remote-controlled text).
      if (args[0] === 'push' && typeof (error as { stdout?: unknown })?.stdout === 'string'
        && /^!\t[^\n]+\t\[rejected\] \((?:fetch first|non-fast-forward)\)\r?$/m.test((error as { stdout: string }).stdout)) {
        throw new ProjectGitError('PROJECT_GIT_BRANCH_ADVANCED', 409);
      }
      throw new ProjectGitError('PROJECT_GIT_UNAVAILABLE', 503, typeof (error as any)?.code === 'number' ? (error as any).code : undefined);
    }
  };
  const authOptions = async (link: ProjectRepositoryLink, provider: InstallationTokenProvider | undefined, readOnly: boolean) => ({
    env: buildProjectGitEnv({ baseEnv: process.env, cloneUrl: link.cloneUrl, token: await tokenFor(link, provider, readOnly) }),
  });
  const now = options.now ?? Date.now;
  const operationTails = new Map<string, Promise<void>>();

  async function serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = operationTails.get(projectId) ?? Promise.resolve();
    let finish!: () => void;
    const current = new Promise<void>((resolveFinish) => { finish = resolveFinish; });
    operationTails.set(projectId, current);
    await previous;
    try {
      return await operation();
    } finally {
      finish();
      if (operationTails.get(projectId) === current) operationTails.delete(projectId);
    }
  }

  async function readStatus(projectId: string, taskId: string): Promise<ProjectGitStatus> {
    const lease = getProjectEditorForTask(projectId, taskId);
    if (!lease) throw new Error('This task is not the Project editor');
    await git(lease.workdir, ['rev-parse', '--is-inside-work-tree']);
    const headSha = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
    const versions = listProjectVersions(projectId).filter(version => version.taskId === taskId);
    const recordedCommits = new Set(versions.map(version => version.commitSha));
    const hasUnpublishedCommit = headSha !== lease.baseSha && !recordedCommits.has(headSha);
    const { stdout: porcelain } = await git(lease.workdir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const changedFiles = changedFilesFromPorcelain(porcelain);
    const { stdout: diff } = changedFiles.length === 0
      ? { stdout: '' }
      : await git(lease.workdir, ['diff', 'HEAD', '--', ...changedFiles]);
    const pending = getPendingProjectPublication(projectId, taskId);
    const defaultBranch = getProjectRepositoryLink(projectId)?.defaultBranch;
    const published = versions.find(version => version.leaseId === lease.id && version.commitSha === headSha && version.branchName === lease.branchName);
    const canPromote = !pending && changedFiles.length === 0 && published && defaultBranch && lease.branchName !== defaultBranch
      && !versions.some(version => version.commitSha === headSha && version.branchName === defaultBranch);
    return {
      ...(canPromote ? { defaultBranchPromotion: { commitSha: headSha, commitMessage: published.commitMessage, targetBranch: defaultBranch } } : {}),
      pendingPublication: pending ? publicPublication(pending) : null,
      clean: !pending && changedFiles.length === 0 && !hasUnpublishedCommit,
      changedFiles,
      summary: pending ? (pending.failureReason === 'branch_advanced' ? 'A GitHub branch has advanced' : 'GitHub publication is not confirmed') : hasUnpublishedCommit
        ? 'A local checkpoint is waiting to be pushed'
        : changedFiles.length === 0
          ? 'No file changes'
          : `${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}`,
      diff: bounded(diff),
    };
  }

  async function releaseEditorUnlocked(input: { projectId: string; taskId: string }): Promise<ProjectEditorLease> {
    const lease = getProjectEditorForTask(input.projectId, input.taskId);
    if (!lease) throw new Error('This task is not the Project editor');
    const status = await readStatus(input.projectId, input.taskId);
    if (status.pendingPublication) throw new ProjectPublicationError('PUBLICATION_PENDING', getPendingProjectPublication(input.projectId, input.taskId)!);
    if (!status.clean) throw new Error('Commit & Push current changes before releasing the editor');
    const released = releaseProjectEditor({ leaseId: lease.id, taskId: input.taskId, now: now() });
    if (!released) throw new Error('This task is not the Project editor');
    return released;
  }

  function repositoryIdentity(link: ProjectRepositoryLink): ProjectPublication['repository'] {
    return { installationId: link.installationId, providerRepositoryId: link.providerRepositoryId, cloneUrl: link.cloneUrl, defaultBranch: link.defaultBranch };
  }
  function rejectPending(projectId: string, taskId: string): void {
    const pending = getPendingProjectPublication(projectId, taskId);
    if (pending) throw new ProjectPublicationError('PUBLICATION_PENDING', pending);
  }
  async function publicationLease(input: PublicationInput, row: ProjectPublication): Promise<ProjectEditorLease> {
    const lease = getProjectEditorForTask(input.projectId, input.taskId);
    if (row.projectId !== input.projectId || row.taskId !== input.taskId || !lease || row.leaseId !== lease.id
      || JSON.stringify(row.repository) !== JSON.stringify(repositoryIdentity(input.repositoryLink))) throw new ProjectPublicationError('PUBLICATION_CONFLICT', row);
    await requireOrigin(lease.workdir, input.repositoryLink);
    return lease;
  }
  async function publicationRefs(lease: ProjectEditorLease, link: ProjectRepositoryLink, provider: InstallationTokenProvider | undefined, deploy = false): Promise<ProjectPublication['refs']> {
    const refs: ProjectPublication['refs'] = [{ ref: `refs/heads/${lease.branchName}`, source: 'commit', createOnly: false }];
    if (deploy && lease.branchName !== link.defaultBranch) refs.push({ ref: `refs/heads/${link.defaultBranch}`, source: 'commit', createOnly: false });
    const emptyBase = await emptyRepositoryBase(lease.workdir);
    if (emptyBase && !(await git(lease.workdir, ['ls-remote', 'origin'], await authOptions(link, provider, true))).stdout.trim()) {
      const ref = refs.find(ref => ref.ref === `refs/heads/${link.defaultBranch}`);
      if (ref) ref.createOnly = true;
      else refs.push({ ref: `refs/heads/${link.defaultBranch}`, source: emptyBase, createOnly: true });
    }
    for (const ref of refs) await git(lease.workdir, ['check-ref-format', ref.ref]);
    return refs;
  }
  async function recoverPrepared(lease: ProjectEditorLease, row: ProjectPublication): Promise<ProjectPublication> {
    if (row.state === 'pending') return row;
    const head = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
    const conflict = () => new ProjectPublicationError('PUBLICATION_CONFLICT', row);
    let commit = row.commitSha;
    if (commit) {
      if ((await git(lease.workdir, ['rev-parse', `${commit}^{tree}`])).stdout.trim() !== row.treeSha) throw conflict();
    } else if (head !== row.parentSha) {
      const parent = (await git(lease.workdir, ['log', '-1', '--format=%P'])).stdout.trim();
      const tree = (await git(lease.workdir, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
      const message = (await git(lease.workdir, ['log', '-1', '--format=%B'])).stdout.trim();
      if (parent !== row.parentSha || tree !== row.treeSha || message !== row.commitMessage) throw conflict();
      commit = head;
    } else {
      let tree = (await git(lease.workdir, ['write-tree'])).stdout.trim();
      if (row.action === 'revert' && tree !== row.treeSha) {
        if ((await git(lease.workdir, ['status', '--porcelain'])).stdout.trim()) throw conflict();
        await git(lease.workdir, ['restore', '--source', row.treeSha, '--staged', '--worktree', '--', '.']);
        tree = (await git(lease.workdir, ['write-tree'])).stdout.trim();
      }
      if (tree !== row.treeSha) throw conflict();
      if (row.action === 'revert' && (await git(lease.workdir, ['diff', '--name-only', '-z'])).stdout) throw conflict();
      await git(lease.workdir, ['-c', 'commit.gpgsign=false', 'commit', '-m', row.commitMessage]);
      commit = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
    }
    await git(lease.workdir, ['update-ref', `refs/olympus/publications/${row.id}`, commit]);
    return setProjectPublicationCommit(row.id, commit);
  }
  async function publish(lease: ProjectEditorLease, row: ProjectPublication, input: PublicationInput): Promise<ProjectVersion> {
    row = await recoverPrepared(lease, row);
    const refs = row.refs.map(ref => ({ ...ref, sha: ref.source === 'commit' ? row.commitSha! : ref.source }));
    const observe = async () => {
      const result = await git(lease.workdir, ['ls-remote', 'origin', ...refs.map(ref => ref.ref)], await authOptions(input.repositoryLink, input.tokenProvider, true));
      return new Map(result.stdout.trim().split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
    };
    let remote: Map<string, string>;
    try { remote = await observe(); } catch { throw new ProjectPublicationError('PUBLICATION_UNCONFIRMED', row); }
    if (refs.every(ref => remote.get(ref.ref) === ref.sha)) return confirmProjectPublication(row.id, now());
    if (refs.some(ref => ref.createOnly && remote.has(ref.ref) && remote.get(ref.ref) !== ref.sha)) throw new ProjectPublicationError('PUBLICATION_CONFLICT', row);
    // Git itself enforces fast-forward updates. Exact create leases preserve empty-repo intent.
    try {
      await git(lease.workdir, ['push', '--porcelain', ...(refs.length > 1 ? ['--atomic'] : []),
        ...refs.filter(ref => ref.createOnly).map(ref => `--force-with-lease=${ref.ref}:${remote.get(ref.ref) ?? ''}`),
        'origin', ...refs.map(ref => `${ref.sha}:${ref.ref}`)], await authOptions(input.repositoryLink, input.tokenProvider, false));
    } catch (error) {
      try {
        const after = await observe();
        if (refs.every(ref => after.get(ref.ref) === ref.sha)) return confirmProjectPublication(row.id, now());
        if (refs.some(ref => ref.createOnly && after.has(ref.ref) && after.get(ref.ref) !== ref.sha)) throw new ProjectPublicationError('PUBLICATION_CONFLICT', row);
      } catch (observed) { if (observed instanceof ProjectPublicationError) throw observed; }
      if (error instanceof GitHubPermissionUpgradeError) throw error;
      if (error instanceof ProjectGitError && error.code === 'PROJECT_GIT_BRANCH_ADVANCED') {
        throw new ProjectPublicationError('PUBLICATION_CONFLICT', markProjectPublicationBranchAdvanced(row.id));
      }
      throw new ProjectPublicationError('PUBLICATION_UNCONFIRMED', row);
    }
    return confirmProjectPublication(row.id, now());
  }

  async function requireOrigin(workdir: string, repositoryLink: ProjectRepositoryLink): Promise<void> {
    validateProjectGitTransportConfig(parseProjectGitConfig((await git(workdir, ['config', '--local', '--includes', '--null', '--list'])).stdout));
    const origin = (await git(workdir, ['remote', 'get-url', 'origin'])).stdout.trim();
    const pushUrls = (await git(workdir, ['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split('\n');
    if (origin !== repositoryLink.cloneUrl || pushUrls.length !== 1 || pushUrls[0] !== repositoryLink.cloneUrl) {
      throw Object.assign(new Error('The checkout’s origin does not match this Project’s GitHub repository. Inspect the repository connection before syncing or publishing.'), { statusCode: 409 });
    }
  }

  async function ensureManagedParents(workdir: string): Promise<void> {
    let current = resolve(options.rootDir);
    await mkdir(current, { recursive: true });
    await pathExists(current);
    for (const part of relative(current, dirname(workdir)).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if (!(await pathExists(current))) {
        try { await mkdir(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await pathExists(current);
      }
    }
  }

  async function validateBaseline(workdir: string, repositoryLink: ProjectRepositoryLink): Promise<string> {
    await requireOrigin(workdir, repositoryLink);
    if ((await git(workdir, ['status', '--porcelain'])).stdout.trim()) throw new Error('The Project baseline has local changes; inspect it before syncing. Task workspaces are preserved.');
    if ((await git(workdir, ['branch', '--show-current'])).stdout.trim() !== repositoryLink.defaultBranch) throw new Error('The Project baseline branch changed; inspect it before syncing.');
    return (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  async function emptyRepositoryBase(workdir: string): Promise<string | null> {
    try {
      return (await git(workdir, ['config', '--local', '--get', EMPTY_REPOSITORY_BASE])).stdout.trim() || null;
    } catch (error) {
      if ((error as ProjectGitError).exitCode === 1) return null;
      throw error;
    }
  }

  async function refreshBaseline(projectId: string, repositoryLink: ProjectRepositoryLink, tokenProvider?: InstallationTokenProvider): Promise<ProjectCpSyncResult> {
    const workdir = projectBaselineWorkdir(options.rootDir, projectId, repositoryLink);
    await ensureManagedParents(workdir);
    const exists = await pathExists(workdir);
    let before: string | null = null;
    if (exists) {
      before = await validateBaseline(workdir, repositoryLink);
    }
    const auth = await authOptions(repositoryLink, tokenProvider, true);
    if (!exists) {
      try {
        await git(dirname(workdir), ['clone', '--no-hardlinks', '--no-recurse-submodules', '--template=', '--branch', repositoryLink.defaultBranch, '--single-branch', repositoryLink.cloneUrl, workdir], auth);
      } catch (error) {
        await rm(workdir, { recursive: true, force: true });
        // A successful, completely empty ref listing distinguishes a new repository
        // from an inaccessible remote or a missing branch in an existing repository.
        const refs = await git(dirname(workdir), ['ls-remote', repositoryLink.cloneUrl], auth).catch(() => { throw error; });
        if (refs.stdout.trim()) throw error;
        try {
          await git(dirname(workdir), ['init', '-b', repositoryLink.defaultBranch, workdir]);
          await git(workdir, ['remote', 'add', 'origin', repositoryLink.cloneUrl]);
          await ensureIdentity(git, workdir);
          await git(workdir, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initialize empty Project repository']);
          const baseSha = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
          await git(workdir, ['config', '--local', EMPTY_REPOSITORY_BASE, baseSha]);
        } catch (initializationError) {
          await rm(workdir, { recursive: true, force: true });
          throw initializationError;
        }
      }
    } else {
      const emptyBase = await emptyRepositoryBase(workdir);
      if (emptyBase === before && !(await git(workdir, ['ls-remote', 'origin'], auth)).stdout.trim()) {
        return { updated: false, currentSha: before!, message: 'Empty GitHub repository; local starting commit is ready for tasks' };
      }
      await git(workdir, ['fetch', 'origin', `refs/heads/${repositoryLink.defaultBranch}:refs/remotes/origin/${repositoryLink.defaultBranch}`], auth);
      if (emptyBase === before) {
        // Only the untouched local starting commit may be replaced, never task work.
        await git(workdir, ['reset', '--hard', `origin/${repositoryLink.defaultBranch}`]);
        await git(workdir, ['config', '--local', '--unset', EMPTY_REPOSITORY_BASE]);
      } else {
        await git(workdir, ['merge', '--ff-only', `origin/${repositoryLink.defaultBranch}`]);
      }
    }
    const currentSha = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
    const updated = before !== currentSha;
    if (await emptyRepositoryBase(workdir) === currentSha) {
      return { updated, currentSha, message: 'Empty GitHub repository; local starting commit is ready for tasks' };
    }
    return { updated, currentSha, message: updated ? `Updated Project source from GitHub (${currentSha.slice(0, 7)})` : `Already up to date with GitHub (${currentSha.slice(0, 7)})` };
  }

  async function acquireEditorUnlocked(input: PrepareProjectTaskInput): Promise<ProjectEditorLease> {
    if (input.repositoryLink.mode !== 'branch_pr') throw new Error('Project repository is not ready for Commit & Push');
    const existing = getProjectEditorForTask(input.projectId, input.taskId);
    if (existing) {
      await git(existing.workdir, ['rev-parse', '--is-inside-work-tree']);
      updateTask(input.taskId, { workdir: existing.workdir });
      return existing;
    }

    const previous = getLatestProjectEditorForTask(input.projectId, input.taskId);
    // Older releases cleared workdir and could hand this directory to another task.
    // Only an explicitly retained task binding permits reactivation.
    if (previous && getTask(input.taskId)?.workdir === previous.workdir) {
      await git(previous.workdir, ['rev-parse', '--is-inside-work-tree']);
      const resumed = reactivateProjectEditor(previous.id, input.taskId, now());
      if (resumed) return resumed;
    }

    const workdir = managedWorkdir(options.rootDir, 'tasks', input.projectId, input.taskId);
    await ensureManagedParents(workdir);
    if (await pathExists(workdir)) throw new Error('This task workspace already exists without its ownership record. Inspect it before starting; saved files were preserved.');
    let cloning = false;
    try {
      await serialized(`baseline:${input.projectId}`, async () => {
        const baseline = projectBaselineWorkdir(options.rootDir, input.projectId, input.repositoryLink);
        await ensureManagedParents(baseline);
        const synced = await refreshBaseline(input.projectId, input.repositoryLink, input.tokenProvider);
        recordProjectSyncEvidence(input.repositoryLink, { verifiedAt: now(), currentSha: synced.currentSha, updated: synced.updated });
        cloning = true;
        await git(dirname(workdir), ['clone', '--no-hardlinks', '--no-recurse-submodules', '--template=', '--single-branch', '--branch', input.repositoryLink.defaultBranch, baseline, workdir]);
        const emptyBase = await emptyRepositoryBase(baseline);
        if (emptyBase) await git(workdir, ['config', '--local', EMPTY_REPOSITORY_BASE, emptyBase]);
      });
      await git(workdir, ['remote', 'set-url', 'origin', input.repositoryLink.cloneUrl]);
      const branchName = generatedBranch(`${input.projectId}-${input.taskId}`);
      await git(workdir, ['checkout', '-b', branchName]);
      await ensureIdentity(git, workdir);
      const baseSha = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
      const lease = acquireProjectEditor({
        projectId: input.projectId, taskId: input.taskId, profileId: input.profileId,
        repositoryFullName: input.repositoryLink.fullName, baseBranch: input.repositoryLink.defaultBranch,
        workdir, branchName, baseSha, leaseToken: randomBytes(24).toString('base64url'), now: now(),
      });
      updateTask(input.taskId, { workdir });
      return lease;
    } catch (error) {
      // This directory did not exist on entry and no agent has used it yet.
      if (cloning && !getProjectEditorForTask(input.projectId, input.taskId)) await rm(workdir, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    async acquireEditor(input) {
      return serialized(`task:${input.taskId}`, () => acquireEditorUnlocked(input));
    },

    async prepareTask(input) {
      return serialized(`task:${input.taskId}`, () => acquireEditorUnlocked(input));
    },

    async updateTaskSource(input) {
      return serialized(`task:${input.taskId}`, async () => {
        rejectPending(input.projectId, input.taskId);
        const lease = await acquireEditorUnlocked(input);
        await requireOrigin(lease.workdir, input.repositoryLink);
        const blocked = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
        if (lease.baseBranch !== input.repositoryLink.defaultBranch
          || (await git(lease.workdir, ['branch', '--show-current'])).stdout.trim() !== lease.branchName) {
          throw blocked('This task’s branch has changed. Review its source before updating from GitHub.');
        }
        if ((await git(lease.workdir, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
          throw blocked('This task has uncommitted changes. Ask the assistant to save a local commit, then update from GitHub. Your files are preserved.');
        }
        for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
          const path = (await git(lease.workdir, ['rev-parse', '--git-path', state])).stdout.trim();
          if (await pathExists(resolve(lease.workdir, path))) throw blocked('Finish the existing Git operation before updating this task.');
        }
        const before = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        const remoteRef = `refs/remotes/origin/${input.repositoryLink.defaultBranch}`;
        await git(lease.workdir, ['fetch', 'origin', `+refs/heads/${input.repositoryLink.defaultBranch}:${remoteRef}`], await authOptions(input.repositoryLink, input.tokenProvider, true));
        const source = (await git(lease.workdir, ['rev-parse', remoteRef])).stdout.trim();
        try {
          await git(lease.workdir, ['merge-base', 'HEAD', source]);
        } catch (error) {
          if (error instanceof ProjectGitError && error.exitCode === 1) {
            throw blocked('This task and GitHub have no shared history, which can happen when an empty repository is initialized separately. Start a new task from the current source, or ask the assistant to reconcile the histories. This task’s files and commits are preserved.');
          }
          throw error;
        }
        try {
          await git(lease.workdir, ['-c', `branch.${lease.branchName}.mergeOptions=`, '-c', 'merge.autostash=false', '-c', 'commit.gpgsign=false', 'merge', '--strategy=ort', '--ff', '--no-squash', '--commit', '--no-edit', '--no-gpg-sign', '--no-overwrite-ignore', source]);
        } catch (error) {
          const conflicts = (await git(lease.workdir, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);
          const mergeHead = (await git(lease.workdir, ['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim();
          if (await pathExists(resolve(lease.workdir, mergeHead))) await git(lease.workdir, ['merge', '--abort']);
          if (conflicts.length) throw blocked('The latest GitHub changes conflict with this task. Ask the assistant to merge origin/' + input.repositoryLink.defaultBranch + ' and resolve the conflicts, then run checks. Your original files and commits are preserved.');
          throw error;
        }
        await git(lease.workdir, ['merge-base', '--is-ancestor', source, 'HEAD']);
        await git(lease.workdir, ['merge-base', '--is-ancestor', before, 'HEAD']);
        if ((await git(lease.workdir, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
          throw blocked('The source update did not finish cleanly. Review this task’s Git state before continuing.');
        }
        // Upstream-only updates are clean; a merge retaining task commits is still unpublished.
        advanceProjectEditorBaseline(lease.id, lease.baseSha, source, now());
        const currentSha = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        return { updated: before !== currentSha, currentSha, message: before === currentSha
          ? 'This task already includes the latest GitHub source.'
          : 'Task updated from GitHub. Run checks before publishing.' };
      });
    },

    async releaseEditor(input) {
      return serialized(`task:${input.taskId}`, () => releaseEditorUnlocked(input));
    },

    async status(input) {
      return serialized(`task:${input.taskId}`, () => readStatus(input.projectId, input.taskId));
    },

    async commitPush(input) {
      return serialized(`task:${input.taskId}`, async () => {
        rejectPending(input.projectId, input.taskId);
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        await requireOrigin(lease.workdir, input.repositoryLink);
        if (!input.deployToDefaultBranch && lease.branchName === input.repositoryLink.defaultBranch) throw new Error('Olympus will not push directly to the default branch');
        const status = await readStatus(input.projectId, input.taskId);
        const promotion = input.deployToDefaultBranch && status.defaultBranchPromotion?.targetBranch === input.repositoryLink.defaultBranch;
        if (status.clean && !promotion) throw new Error('There are no changes to Commit & Push');
        let message = validateCommitMessage(input.message);
        const head = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        const unpublished = head !== lease.baseSha && !listProjectVersions(input.projectId).some(version => version.taskId === input.taskId && version.commitSha === head);
        const refs = await publicationRefs(lease, input.repositoryLink, input.tokenProvider, input.deployToDefaultBranch);
        let parentSha = head; let commitSha: string | null = null; let changedFiles = status.changedFiles;
        if ((unpublished || promotion) && status.changedFiles.length === 0) {
          commitSha = head;
          parentSha = (await git(lease.workdir, ['rev-parse', 'HEAD^'])).stdout.trim();
          message = validateCommitMessage((await git(lease.workdir, ['log', '-1', '--format=%s'])).stdout);
          changedFiles = (await git(lease.workdir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'])).stdout.split('\0').filter(Boolean).slice(0, MAX_CHANGED_FILES);
        } else await git(lease.workdir, ['add', '--all', '--', '.']);
        const treeSha = (await git(lease.workdir, commitSha ? ['rev-parse', `${commitSha}^{tree}`] : ['write-tree'])).stdout.trim();
        const row = createProjectPublication({ id: randomUUID(), projectId: input.projectId, taskId: input.taskId, leaseId: lease.id,
          repository: repositoryIdentity(input.repositoryLink), action: 'commit_push', revertedVersionId: null,
          parentSha, treeSha, commitSha, commitMessage: message, changedFiles,
          targetBranch: input.deployToDefaultBranch ? input.repositoryLink.defaultBranch : lease.branchName, refs, createdAt: now() });
        return publish(lease, row, { ...input, publicationId: row.id });
      });
    },
    async retryPublication(input) {
      return serialized(`task:${input.taskId}`, async () => {
        const row = getProjectPublication(input.publicationId);
        if (!row || row.state === 'abandoned') throw new ProjectPublicationError('PUBLICATION_CONFLICT');
        if (row.projectId !== input.projectId || row.taskId !== input.taskId || JSON.stringify(row.repository) !== JSON.stringify(repositoryIdentity(input.repositoryLink))) throw new ProjectPublicationError('PUBLICATION_CONFLICT');
        if (row.state === 'confirmed') return getProjectVersion(row.id)!;
        const lease = await publicationLease(input, row);
        return publish(lease, row, input);
      });
    },
    async abandonPublication(input) {
      return serialized(`task:${input.taskId}`, async () => {
        const row = getProjectPublication(input.publicationId);
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!row || row.projectId !== input.projectId || row.taskId !== input.taskId || !lease || row.leaseId !== lease.id || row.state === 'confirmed') throw new ProjectPublicationError('PUBLICATION_CONFLICT');
        abandonProjectPublication(row.id);
      });
    },
    async revert(input) {
      return serialized(`task:${input.taskId}`, async () => {
        rejectPending(input.projectId, input.taskId);
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        await requireOrigin(lease.workdir, input.repositoryLink);
        const target = getProjectVersion(input.versionId);
        if (!target || target.projectId !== input.projectId || target.taskId !== input.taskId) throw new Error('Project version not found for this task');
        const status = await readStatus(input.projectId, input.taskId);
        if (!status.clean) throw new Error('Commit & Push or discard current changes before reverting');
        const parentSha = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        const treeSha = (await git(lease.workdir, ['rev-parse', `${target.commitSha}^{tree}`])).stdout.trim();
        if ((await git(lease.workdir, ['rev-parse', 'HEAD^{tree}'])).stdout.trim() === treeSha) throw new Error('This version has the same files as the current version');
        const refs = await publicationRefs(lease, input.repositoryLink, input.tokenProvider);
        const changedFiles = (await git(lease.workdir, ['diff', '--name-only', '-z', 'HEAD', target.commitSha])).stdout.split('\0').filter(Boolean).slice(0, MAX_CHANGED_FILES);
        const row = createProjectPublication({ id: randomUUID(), projectId: input.projectId, taskId: input.taskId, leaseId: lease.id,
          repository: repositoryIdentity(input.repositoryLink), action: 'revert', revertedVersionId: target.id,
          parentSha, treeSha, commitSha: null, commitMessage: `Restore ${target.commitSha.slice(0, 7)} — ${target.commitMessage}`.slice(0, 200),
          changedFiles, targetBranch: lease.branchName, refs, createdAt: now() });
        return publish(lease, row, { ...input, publicationId: row.id });
      });
    },

    async sync(input) {
      // Project sync updates only the source for future tasks. Existing work stays put.
      return serialized(`baseline:${input.projectId}`, () => refreshBaseline(input.projectId, input.repositoryLink, input.tokenProvider));
    },
  };
}
