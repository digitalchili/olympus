import { randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectEditorLease, ProjectRepositoryLink, ProjectVersion } from '../shared/types.js';
import {
  acquireProjectEditor,
  getProjectEditor,
  getProjectEditorForTask,
  getProjectVersion,
  listProjectVersions,
  recordProjectVersion,
  releaseProjectEditor,
  transferProjectEditor,
} from './db/project-cp.js';
import { getTask, updateTask } from './db/queries.js';

const execFile = promisify(execFileCallback);
const MAX_DIFF_BYTES = 60_000;
const MAX_CHANGED_FILES = 200;

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
  ) {
    super(`${activeTaskTitle} is currently using this Project repository`);
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

function managedWorkdir(rootDir: string, projectId: string): string {
  const root = resolve(rootDir);
  const workdir = resolve(root, projectId);
  if (!workdir.startsWith(`${root}${sep}`)) throw new Error('Invalid managed Project checkout path');
  return workdir;
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
    const recordedCommits = new Set(listProjectVersions(projectId).map((version) => version.commitSha));
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

  async function pushWithRecovery(input: {
    lease: ProjectEditorLease;
    repositoryLink: ProjectRepositoryLink;
    parentSha: string;
    commitSha: string;
    tokenProvider?: InstallationTokenProvider;
    targetBranch?: string;
    deployToDefaultBranch?: boolean;
  }): Promise<void> {
    const token = await tokenFor(input.repositoryLink, input.tokenProvider);
    const targetBranch = input.targetBranch ?? input.lease.branchName;
    const refspecs = input.deployToDefaultBranch && targetBranch !== input.lease.branchName
      ? [`HEAD:refs/heads/${input.lease.branchName}`, `HEAD:refs/heads/${targetBranch}`]
      : [`HEAD:refs/heads/${input.lease.branchName}`];
    try {
      await git(input.lease.workdir, ['push', 'origin', ...refspecs], { env: gitHubAuthEnv(token) });
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

  async function syncManagedCheckout(
    workdir: string,
    repositoryLink: ProjectRepositoryLink,
    tokenProvider?: InstallationTokenProvider,
  ): Promise<void> {
    const token = await tokenFor(repositoryLink, tokenProvider);
    const auth = { env: gitHubAuthEnv(token) };
    const protectedBranch = (await git(workdir, ['branch', '--show-current'])).stdout.trim();
    if (!protectedBranch || protectedBranch === repositoryLink.defaultBranch) {
      throw new Error('Managed Project checkout is not on a safe Olympus branch');
    }
    const remoteProtected = await git(workdir, ['ls-remote', '--heads', 'origin', `refs/heads/${protectedBranch}`], auth);
    if (remoteProtected.stdout.trim()) {
      await git(workdir, ['fetch', 'origin', `refs/heads/${protectedBranch}:refs/remotes/origin/${protectedBranch}`], auth);
      await git(workdir, ['merge', '--ff-only', `origin/${protectedBranch}`]);
    }
    await git(workdir, ['fetch', 'origin', `refs/heads/${repositoryLink.defaultBranch}:refs/remotes/origin/${repositoryLink.defaultBranch}`], auth);
    try {
      await git(workdir, ['merge', '--no-edit', `origin/${repositoryLink.defaultBranch}`]);
    } catch (error) {
      try {
        await git(workdir, ['merge', '--abort']);
      } catch {
        // A failed merge can exit before MERGE_HEAD exists; preserve the original error.
      }
      throw error;
    }
  }

  async function acquireEditorUnlocked(
    input: PrepareProjectTaskInput,
    optionsOverride: { syncExisting?: boolean } = {},
  ): Promise<ProjectEditorLease> {
    if (input.repositoryLink.mode !== 'branch_pr') throw new Error('Project repository is not ready for Commit & Push');
    const existing = getProjectEditor(input.projectId);
    if (existing) {
      if (existing.taskId !== input.taskId) throw new Error('Project already has an editor');
      await git(existing.workdir, ['rev-parse', '--is-inside-work-tree']);
      updateTask(input.taskId, { workdir: existing.workdir });
      return existing;
    }

    await mkdir(options.rootDir, { recursive: true });
    const workdir = managedWorkdir(options.rootDir, input.projectId);
    let checkoutExists = await pathExists(workdir);
    let branchName: string;
    let baseSha: string;
    try {
      if (checkoutExists) {
        const { stdout: remoteUrl } = await git(workdir, ['remote', 'get-url', 'origin']);
        if (remoteUrl.trim() !== input.repositoryLink.cloneUrl) {
          const status = await git(workdir, ['status', '--porcelain']);
          if (status.stdout.trim()) throw new Error('Managed Project checkout has uncommitted changes and needs recovery');
          await rm(workdir, { recursive: true, force: true });
          checkoutExists = false;
        }
      }
      if (checkoutExists) {
        const status = await git(workdir, ['status', '--porcelain']);
        if (status.stdout.trim()) throw new Error('Managed Project checkout has uncommitted changes and needs recovery');
        branchName = (await git(workdir, ['branch', '--show-current'])).stdout.trim();
        if (!branchName || branchName === input.repositoryLink.defaultBranch) throw new Error('Managed Project checkout is not on a safe Olympus branch');
        if (optionsOverride.syncExisting !== false) {
          await syncManagedCheckout(workdir, input.repositoryLink, input.tokenProvider);
        }
      } else {
        const token = await tokenFor(input.repositoryLink, input.tokenProvider);
        await git(options.rootDir, ['clone', '--branch', input.repositoryLink.defaultBranch, '--single-branch', input.repositoryLink.cloneUrl, workdir], { env: gitHubAuthEnv(token) });
        branchName = generatedBranch(input.projectId);
        await git(workdir, ['checkout', '-b', branchName]);
      }
      await ensureIdentity(git, workdir);
      baseSha = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
      const lease = acquireProjectEditor({
        projectId: input.projectId,
        taskId: input.taskId,
        profileId: input.profileId,
        repositoryFullName: input.repositoryLink.fullName,
        baseBranch: input.repositoryLink.defaultBranch,
        workdir,
        branchName,
        baseSha,
        leaseToken: randomBytes(24).toString('base64url'),
        now: now(),
      });
      updateTask(input.taskId, { workdir });
      return lease;
    } catch (error) {
      if (!checkoutExists) await rm(workdir, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    async acquireEditor(input) {
      return serialized(input.projectId, () => acquireEditorUnlocked(input));
    },

    async prepareTask(input) {
      return serialized(input.projectId, async () => {
        const existing = getProjectEditor(input.projectId);
        if (existing?.taskId === input.taskId) return acquireEditorUnlocked(input);
        if (existing) {
          const owner = getTask(existing.taskId);
          const status = await readStatus(input.projectId, existing.taskId);
          const canHandOff = status.clean && (owner?.status === 'in_review' || owner?.status === 'done');
          if (!canHandOff) {
            throw new ProjectRepositoryBusyError(existing.taskId, owner?.title ?? 'Another task');
          }
          await syncManagedCheckout(existing.workdir, input.repositoryLink, input.tokenProvider);
          const branchName = (await git(existing.workdir, ['branch', '--show-current'])).stdout.trim();
          const baseSha = (await git(existing.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
          return transferProjectEditor({
            previousLeaseId: existing.id,
            previousTaskId: existing.taskId,
            projectId: input.projectId,
            taskId: input.taskId,
            profileId: input.profileId,
            repositoryFullName: input.repositoryLink.fullName,
            baseBranch: input.repositoryLink.defaultBranch,
            workdir: existing.workdir,
            branchName,
            baseSha,
            leaseToken: randomBytes(24).toString('base64url'),
            now: now(),
          });
        }
        return acquireEditorUnlocked(input, { syncExisting: false });
      });
    },

    async releaseEditor(input) {
      return serialized(input.projectId, async () => {
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        const status = await readStatus(input.projectId, input.taskId);
        if (!status.clean) throw new Error('Commit & Push or discard current changes before releasing the editor');
        const released = releaseProjectEditor({ leaseId: lease.id, taskId: input.taskId, now: now() });
        if (!released) throw new Error('This task is not the Project editor');
        updateTask(input.taskId, { workdir: null });
        return released;
      });
    },

    async status(input) {
      return serialized(input.projectId, () => readStatus(input.projectId, input.taskId));
    },

    async commitPush(input) {
      return serialized(input.projectId, async () => {
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        if (!input.deployToDefaultBranch && lease.branchName === input.repositoryLink.defaultBranch) {
          throw new Error('Olympus will not push directly to the default branch');
        }
        const status = await readStatus(input.projectId, input.taskId);
        if (status.clean) throw new Error('There are no changes to Commit & Push');
        const requestedMessage = validateCommitMessage(input.message);
        const currentHead = (await git(lease.workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        const recordedCommits = new Set(listProjectVersions(input.projectId).map((version) => version.commitSha));
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
      return serialized(input.projectId, async () => {
        const lease = getProjectEditorForTask(input.projectId, input.taskId);
        if (!lease) throw new Error('This task is not the Project editor');
        const target = getProjectVersion(input.versionId);
        if (!target || target.projectId !== input.projectId) throw new Error('Project version not found');
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
      return serialized(input.projectId, async () => {
        await mkdir(options.rootDir, { recursive: true });
        const workdir = managedWorkdir(options.rootDir, input.projectId);
        const checkoutExists = await pathExists(workdir);
        const token = await tokenFor(input.repositoryLink, input.tokenProvider);
        const auth = { env: gitHubAuthEnv(token) };

        if (!checkoutExists) {
          await git(options.rootDir, ['clone', '--branch', input.repositoryLink.defaultBranch, '--single-branch', input.repositoryLink.cloneUrl, workdir], auth);
          const branchName = generatedBranch(input.projectId);
          await git(workdir, ['checkout', '-b', branchName]);
          await ensureIdentity(git, workdir);
          const currentSha = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
          return {
            updated: true,
            currentSha,
            message: `Cloned and synced repository at ${currentSha.slice(0, 7)}`,
          };
        }

        const status = await git(workdir, ['status', '--porcelain']);
        if (status.stdout.trim()) {
          throw new Error('Project checkout has uncommitted changes; please commit or discard them before syncing.');
        }

        const headBefore = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
        await syncManagedCheckout(workdir, input.repositoryLink, input.tokenProvider);
        const headAfter = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();

        const updated = headBefore !== headAfter;
        return {
          updated,
          currentSha: headAfter,
          message: updated
            ? `Successfully pulled latest changes from GitHub (${headAfter.slice(0, 7)})`
            : `Already up to date with GitHub (${headAfter.slice(0, 7)})`,
        };
      });
    },
  };
}
