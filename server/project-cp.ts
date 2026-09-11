import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectEditorLease, ProjectRepositoryLink, ProjectVersion } from '../shared/types.js';
import {
  acquireProjectEditor,
  getLatestProjectEditorForTask,
  getProjectEditorForTask,
  getProjectVersion,
  listProjectVersions,
  recordProjectVersion,
  releaseProjectEditor,
  reactivateProjectEditor,
} from './db/project-cp.js';
import { getTask, updateTask } from './db/queries.js';

const execFile = promisify(execFileCallback);
const MAX_DIFF_BYTES = 60_000;
const MAX_CHANGED_FILES = 200;
const EMPTY_REPOSITORY_BASE = 'olympus.emptyRepositoryBase';

type GitRunResult = { stdout: string; stderr: string };
export type GitRunner = (cwd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => Promise<GitRunResult>;
export type InstallationTokenProvider = (installationId: number) => Promise<string>;

export interface ProjectGitStatus {
  clean: boolean;
  changedFiles: string[];
  summary: string;
  diff: string;
}

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
    env: { ...process.env, ...options?.env },
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

function gitHubAuthEnv(token: string | null): Record<string, string | undefined> | undefined {
  if (!token) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

async function tokenFor(link: ProjectRepositoryLink, tokenProvider?: InstallationTokenProvider): Promise<string | null> {
  if (!tokenProvider || !/^https:\/\/github\.com\//i.test(link.cloneUrl)) return null;
  return tokenProvider(link.installationId);
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
  const git = options.gitRunner ?? defaultGitRunner;
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
    const recordedCommits = new Set(listProjectVersions(projectId).filter(version => version.taskId === taskId).map(version => version.commitSha));
    const hasUnpublishedCommit = headSha !== lease.baseSha && !recordedCommits.has(headSha);
    const { stdout: porcelain } = await git(lease.workdir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const changedFiles = changedFilesFromPorcelain(porcelain);
    const { stdout: diff } = changedFiles.length === 0
      ? { stdout: '' }
      : await git(lease.workdir, ['diff', 'HEAD', '--', ...changedFiles]);
    return {
      clean: changedFiles.length === 0 && !hasUnpublishedCommit,
      changedFiles,
      summary: hasUnpublishedCommit
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
    if (!status.clean) throw new Error('Commit & Push current changes before releasing the editor');
    const released = releaseProjectEditor({ leaseId: lease.id, taskId: input.taskId, now: now() });
    if (!released) throw new Error('This task is not the Project editor');
    return released;
  }

  async function pushWithRecovery(input: {
    lease: ProjectEditorLease;
    repositoryLink: ProjectRepositoryLink;
    parentSha: string;
    commitSha: string;
    tokenProvider?: InstallationTokenProvider;
    targetBranch?: string;
    deployToDefaultBranch?: boolean;
  }): Promise<void> {
    await requireOrigin(input.lease.workdir, input.repositoryLink);
    const token = await tokenFor(input.repositoryLink, input.tokenProvider);
    const targetBranch = input.targetBranch ?? input.lease.branchName;
    const refspecs = input.deployToDefaultBranch && targetBranch !== input.lease.branchName
      ? [`HEAD:refs/heads/${input.lease.branchName}`, `HEAD:refs/heads/${targetBranch}`]
      : [`HEAD:refs/heads/${input.lease.branchName}`];
    try {
      const emptyBase = await emptyRepositoryBase(input.lease.workdir);
      const initializeDefault = emptyBase && !(await git(input.lease.workdir, ['ls-remote', 'origin'], { env: gitHubAuthEnv(token) })).stdout.trim();
      if (initializeDefault && !input.deployToDefaultBranch) {
        // Keep code on the task branch until the user explicitly deploys or merges.
        refspecs.push(`${emptyBase}:refs/heads/${input.repositoryLink.defaultBranch}`);
      }
      await git(input.lease.workdir, [
        'push', ...(refspecs.length > 1 ? ['--atomic'] : []),
        // Create only: a concurrent first push must never be overwritten.
        ...(initializeDefault ? [`--force-with-lease=refs/heads/${input.repositoryLink.defaultBranch}:`] : []),
        'origin', ...refspecs,
      ], { env: gitHubAuthEnv(token) });
    } catch (error) {
      try {
        const remote = await git(
          input.lease.workdir,
          ['ls-remote', 'origin', `refs/heads/${targetBranch}`],
          { env: gitHubAuthEnv(token) },
        );
        const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? '';
        if (remoteSha === input.commitSha) return;
      } catch {
        // Preserve the original push error; an unreachable remote is not proof of success.
      }
      await git(input.lease.workdir, ['reset', '--soft', input.parentSha]);
      throw error;
    }
  }

  async function requireOrigin(workdir: string, repositoryLink: ProjectRepositoryLink): Promise<void> {
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
      if ((error as { code?: number }).code === 1) return null;
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
    const auth = { env: gitHubAuthEnv(await tokenFor(repositoryLink, tokenProvider)) };
    if (!exists) {
      try {
        await git(dirname(workdir), ['clone', '--no-hardlinks', '--branch', repositoryLink.defaultBranch, '--single-branch', repositoryLink.cloneUrl, workdir], auth);
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
        if (await pathExists(baseline)) await validateBaseline(baseline, input.repositoryLink);
        else await refreshBaseline(input.projectId, input.repositoryLink, input.tokenProvider);
        cloning = true;
        await git(dirname(workdir), ['clone', '--no-hardlinks', '--single-branch', '--branch', input.repositoryLink.defaultBranch, baseline, workdir]);
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

    async releaseEditor(input) {
      return serialized(`task:${input.taskId}`, () => releaseEditorUnlocked(input));
    },

    async status(input) {
      return serialized(`task:${input.taskId}`, () => readStatus(input.projectId, input.taskId));
    },

    async commitPush(input) {
      return serialized(`task:${input.taskId}`, async () => {
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        await requireOrigin(lease.workdir, input.repositoryLink);
        if (!input.deployToDefaultBranch && lease.branchName === input.repositoryLink.defaultBranch) {
          throw new Error('Olympus will not push directly to the default branch');
        }
        const status = await readStatus(input.projectId, input.taskId);
        if (status.clean) throw new Error('There are no changes to Commit & Push');
        const requestedMessage = validateCommitMessage(input.message);
        const currentHead = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        const recordedCommits = new Set(listProjectVersions(input.projectId).filter(version => version.taskId === input.taskId).map(version => version.commitSha));
        const hasUnpublishedCommit = currentHead !== lease.baseSha && !recordedCommits.has(currentHead);
        let parentSha: string;
        let commitSha: string;
        let message: string;
        let changedFiles: string[];
        if (hasUnpublishedCommit && status.changedFiles.length === 0) {
          parentSha = (await git(lease.workdir, ['rev-parse', 'HEAD^'])).stdout.trim();
          commitSha = currentHead;
          message = validateCommitMessage((await git(lease.workdir, ['log', '-1', '--format=%s'])).stdout);
          const names = await git(lease.workdir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD']);
          changedFiles = names.stdout.split('\0').filter(Boolean).slice(0, MAX_CHANGED_FILES);
        } else {
          parentSha = currentHead;
          message = requestedMessage;
          await git(lease.workdir, ['add', '--all', '--', '.']);
          await git(lease.workdir, ['commit', '-m', message]);
          commitSha = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
          changedFiles = status.changedFiles;
        }
        const targetBranch = input.deployToDefaultBranch
          ? input.repositoryLink.defaultBranch
          : lease.branchName;
        await pushWithRecovery({
          lease,
          repositoryLink: input.repositoryLink,
          parentSha,
          commitSha,
          tokenProvider: input.tokenProvider,
          targetBranch,
          deployToDefaultBranch: input.deployToDefaultBranch,
        });
        return recordProjectVersion({
          projectId: input.projectId,
          taskId: input.taskId,
          leaseId: lease.id,
          action: 'commit_push',
          commitSha,
          parentSha,
          branchName: targetBranch,
          commitMessage: message,
          changedFiles,
          pushedAt: now(),
        });
      });
    },

    async revert(input) {
      return serialized(`task:${input.taskId}`, async () => {
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        const target = getProjectVersion(input.versionId);
        if (!target || target.projectId !== input.projectId || target.taskId !== input.taskId) throw new Error('Project version not found for this task');
        await requireOrigin(lease.workdir, input.repositoryLink);
        const currentStatus = await readStatus(input.projectId, input.taskId);
        if (!currentStatus.clean) throw new Error('Commit & Push or discard current changes before reverting');
        const parentSha = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        if (parentSha === target.commitSha) throw new Error('This is already the current version');
        await git(lease.workdir, ['cat-file', '-e', `${target.commitSha}^{commit}`]);
        await git(lease.workdir, ['restore', '--source', target.commitSha, '--staged', '--worktree', '--', '.']);
        const restoredStatus = await readStatus(input.projectId, input.taskId);
        if (restoredStatus.clean) throw new Error('This version has the same files as the current version');
        const message = `Restore ${target.commitSha.slice(0, 7)} — ${target.commitMessage}`.slice(0, 200);
        await git(lease.workdir, ['commit', '-m', message]);
        const commitSha = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        await pushWithRecovery({ lease, repositoryLink: input.repositoryLink, parentSha, commitSha, tokenProvider: input.tokenProvider });
        return recordProjectVersion({
          projectId: input.projectId,
          taskId: input.taskId,
          leaseId: lease.id,
          action: 'revert',
          commitSha,
          parentSha,
          revertedVersionId: target.id,
          branchName: lease.branchName,
          commitMessage: message,
          changedFiles: restoredStatus.changedFiles,
          pushedAt: now(),
        });
      });
    },

    async sync(input) {
      // Project sync updates only the source for future tasks. Existing work stays put.
      return serialized(`baseline:${input.projectId}`, () => refreshBaseline(input.projectId, input.repositoryLink, input.tokenProvider));
    },
  };
}
