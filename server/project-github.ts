import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StudioGitHubRepository, Task } from '../shared/types.js';
import type { ProjectGitHubRequest } from './adapters/types.js';
import type { GitRunner } from './project-cp.js';
import type { StudioGitHubGateway } from './routes/studio.js';
import { getTask } from './db/queries.js';
import { getProjectGitHubInstallationIds } from './db/project-github-access.js';
import { requireProfileProjectAccess } from './project-access.js';
import { untilStopped } from './run-cancellation.js';

const repositoryName = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
type SourceGitRunner = (cwd: string, args: string[], options?: { env?: Record<string, string | undefined>; signal?: AbortSignal }) => ReturnType<GitRunner>;

export const runProjectSourceGit: SourceGitRunner = (cwd, args, options) => new Promise((resolve, reject) => {
  const signal = options?.signal;
  if (signal?.aborted) { reject(signal.reason); return; }
  const child = spawn('git', args, {
    cwd, env: { ...process.env, ...options?.env }, stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = ''; let stderr = ''; let bytes = 0; let tooLarge = false;
  const abort = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* Already exited. */ }
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const capture = (chunk: Buffer, output: 'stdout' | 'stderr') => {
    bytes += chunk.length;
    if (bytes > 5 * 1024 * 1024) { tooLarge = true; abort(); return; }
    if (output === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout.on('data', chunk => capture(chunk, 'stdout'));
  child.stderr.on('data', chunk => capture(chunk, 'stderr'));
  child.on('error', () => { signal?.removeEventListener('abort', abort); reject(new Error('Git source operation failed')); });
  child.on('close', code => {
    signal?.removeEventListener('abort', abort);
    if (code !== 0 || signal?.aborted || tooLarge) reject(new Error('Git source operation failed'));
    else resolve({ stdout, stderr });
  });
});

function readAuth(token: string): Record<string, string> {
  const entries = [
    ['http.https://github.com/.extraHeader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`],
    ['credential.helper', ''], ['http.followRedirects', 'false'], ['core.hooksPath', '/dev/null'],
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'],
  ];
  return Object.fromEntries([
    ['GIT_TERMINAL_PROMPT', '0'], ['GIT_CONFIG_NOSYSTEM', '1'], ['GIT_CONFIG_GLOBAL', '/dev/null'],
    ['GIT_CONFIG_COUNT', String(entries.length)],
    ...entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]]),
  ]);
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe source directory');
}

export function createProjectGitHubService(options: {
  github: StudioGitHubGateway;
  workspaceForTask: (task: Task) => string;
  gitRunner?: SourceGitRunner;
}) {
  const git = options.gitRunner ?? runProjectSourceGit;
  const pending = new Map<string, Promise<unknown>>();

  async function execute(task: Task, request: ProjectGitHubRequest, active: () => boolean, signal: AbortSignal): Promise<Record<string, unknown>> {
    const assertAccess = (installationId?: number) => {
      const current = getTask(task.id);
      if (signal.aborted || !active() || !current?.project_id || current.kind === 'bot' || current.project_id !== task.project_id
        || current.profile_name !== task.profile_name) throw new Error('Task access changed');
      requireProfileProjectAccess(current.project_id, current.profile_name ?? 'default', 'view');
      const ids = getProjectGitHubInstallationIds(current.project_id);
      if (!ids.length || (installationId !== undefined && !ids.includes(installationId))) throw new Error('Account access changed');
      return ids;
    };
    try {
      const ids = assertAccess();
      if (!options.github.configured || !options.github.installationToken) return { ok: false, error: 'GitHub is not connected in Olympus settings.' };
      if (!['list', 'check', 'clone'].includes(request.action)) return { ok: false, error: 'Use list, check, or clone.' };
      if (request.action !== 'list' && (typeof request.repository !== 'string' || !repositoryName.test(request.repository)
        || ['.', '..'].includes(request.repository.split('/')[1]))) return { ok: false, error: 'Use a GitHub repository name in owner/repository form.' };

      const repositories: Array<StudioGitHubRepository & { installationId: number }> = [];
      for (const id of ids) {
        assertAccess(id);
        const available = await options.github.listRepositories(id, { readOnly: true, signal });
        assertAccess(id);
        repositories.push(...available.map(repository => ({ ...repository, installationId: id })));
      }
      if (request.action === 'list') {
        for (const id of ids) assertAccess(id);
        return { ok: true, repositories: repositories.map(({ fullName, defaultBranch, private: isPrivate, installationId }) => ({ fullName, defaultBranch, private: isPrivate, installationId })) };
      }
      const repository = repositories.find(repo => repo.fullName.toLowerCase() === request.repository!.toLowerCase());
      if (!repository) return { ok: false, error: 'This repository is not available through the Project’s selected GitHub accounts. Check Project settings and the account’s GitHub App repository access.' };
      const { installationId, fullName, defaultBranch } = repository;
      if (!repositoryName.test(fullName) || ['.', '..'].includes(fullName.split('/')[1])
        || repository.cloneUrl !== `https://github.com/${fullName}.git`) throw new Error('Unexpected repository URL');
      assertAccess(installationId);
      const token = await options.github.installationToken(installationId, { readOnly: true, repositoryId: repository.id, signal });
      const scratch = await mkdtemp(join(tmpdir(), 'olympus-source-read-'));
      try {
        assertAccess(installationId);
        // Authenticated Git runs only in a fresh directory, never in agent-editable
        // repository configuration. Credentials cannot trigger local hooks/helpers.
        const auth = { env: readAuth(token), signal };
        const refs = await git(scratch, ['ls-remote', '--heads', repository.cloneUrl], auth);
        assertAccess(installationId);
        const branches = refs.stdout.trim().split('\n').map(line => line.split('\t')[1]).filter(ref => ref?.startsWith('refs/heads/')).map(ref => ref.slice(11)).sort();
        if (request.action === 'check') return { ok: true, repository: fullName, defaultBranch, branches };

        if (!/^[A-Za-z0-9_-]+$/.test(task.id)) throw new Error('Invalid task path');
        let parent = resolve(options.workspaceForTask(task));
        await directory(parent);
        const [owner, name] = fullName.toLowerCase().split('/');
        for (const part of ['tasks', task.id, 'sources', owner]) {
          parent = join(parent, part);
          await directory(parent);
        }
        const path = join(parent, name);
        const existing = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (existing) {
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Unsafe source directory');
          const metadata = await lstat(join(path, '.git'));
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid source repository');
          const origin = await git(path, ['config', '--local', '--no-includes', '--get', 'remote.origin.url'], { signal });
          const toplevel = await git(path, ['rev-parse', '--show-toplevel'], { signal });
          if (origin.stdout.trim() !== repository.cloneUrl || await realpath(toplevel.stdout.trim()) !== await realpath(path)) throw new Error('Source repository changed');
          assertAccess(installationId);
          return { ok: true, repository: fullName, defaultBranch, branches, path, existing: true };
        }
        const clone = join(scratch, 'source');
        await git(scratch, ['clone', '--no-hardlinks', '--no-recurse-submodules', '--template=', repository.cloneUrl, clone], auth);
        // Store no token and make accidental source pushes fail explicitly.
        await git(clone, ['remote', 'set-url', 'origin', repository.cloneUrl], { signal });
        await git(clone, ['remote', 'set-url', '--push', 'origin', 'DISABLED'], { signal });
        assertAccess(installationId);
        // Profile workspaces may live on a different Docker volume from /tmp.
        const staging = await mkdtemp(join(parent, '.source-'));
        try {
          await cp(clone, join(staging, 'repository'), { recursive: true, verbatimSymlinks: true });
          assertAccess(installationId);
          await rename(join(staging, 'repository'), path);
        } finally { await rm(staging, { recursive: true, force: true }); }
        return { ok: true, repository: fullName, defaultBranch, branches, path, existing: false };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    } catch {
      return { ok: false, error: 'Could not read this Project’s GitHub sources. Check the selected accounts, repository permissions, and that the task is still running. If a source folder already exists, it must remain a Git clone of the requested repository. Existing files were preserved.' };
    }
  }

  return {
    async execute(task: Task, request: ProjectGitHubRequest, active: () => boolean): Promise<Record<string, unknown>> {
      // Serialize a source destination without blocking other tasks or repositories.
      const key = `${task.id}:${request.repository?.toLowerCase() ?? ''}`;
      const previous = pending.get(key);
      const controller = new AbortController();
      const operation = (async () => { await previous?.catch(() => {}); return execute(task, request, active, controller.signal); })();
      pending.set(key, operation);
      try {
        return await untilStopped(() => operation, () => !active());
      } catch {
        controller.abort();
        await operation.catch(() => {});
        return { ok: false, error: 'The Project run stopped before repository access completed. Existing source files were preserved.' };
      } finally { if (pending.get(key) === operation) pending.delete(key); }
    },
  };
}
