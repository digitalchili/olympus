import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), 'olympus-project-task-workspace-'));
const dispatchHome = join(root, 'dispatch');
const hermesHome = join(root, 'hermes');
const writerHome = join(hermesHome, 'profiles', 'writer');
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.HERMES_HOME = hermesHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'workspace-routes.db');

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd })).stdout.trim();
}

try {
  await mkdir(writerHome, { recursive: true });
  await writeFile(join(hermesHome, 'profile.yaml'), 'displayName: Default\nactive: true\n');
  await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  provider: openai-codex\n  default: gpt-5.6-sol\n');
  await writeFile(join(writerHome, 'profile.yaml'), 'displayName: Writer\nactive: true\n');
  await writeFile(join(writerHome, 'config.yaml'), '{}\n');

  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  await mkdir(seed, { recursive: true });
  await git(seed, ['init', '-b', 'main']);
  await writeFile(join(seed, 'AGENTS.md'), 'Thaweephan instructions\n');
  await git(seed, ['add', 'AGENTS.md']);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-m', 'Initial']);
  await execFile('git', ['clone', '--bare', seed, remote]);

  const { createProject } = await import('../server/db/projects.js');
  const { upsertProjectRepositoryLink } = await import('../server/db/projects.js');
  const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
  const { insertTask, getTask } = await import('../server/db/queries.js');
  const { getProjectEditor } = await import('../server/db/project-cp.js');
  const { transferProjectEditor } = await import('../server/db/project-cp.js');
  const { createProjectCpService } = await import('../server/project-cp.js');
  const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
  const { default: db } = await import('../server/db/index.js');

  const project = createProject({
    name: 'Thaweephan Intranet',
    purpose: 'Develop Thaweephan',
    managerProfileId: 'default',
    changedBy: 'test',
  });
  upsertGitHubInstallation({
    id: 77,
    accountLogin: 'leakim69',
    accountType: 'User',
    permissionMode: 'read_write',
  });
  upsertProjectRepositoryLink(project.id, 77, {
    id: 9001,
    name: 'thaweephan',
    fullName: 'leakim69/thaweephan',
    owner: 'leakim69',
    private: true,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/leakim69/thaweephan',
    cloneUrl: remote,
  });
  const firstTask = insertTask({
    title: 'Review AGENTS.md',
    description: 'Read the repository instructions',
    status: 'in_progress',
    project_id: project.id,
    profile_name: 'default',
    handling_profile_id: 'default',
  });
  const secondTask = insertTask({
    title: 'Second repository task',
    description: 'Inspect the same repository',
    status: 'in_progress',
    project_id: project.id,
    profile_name: 'default',
    handling_profile_id: 'default',
  });

  const managedRoot = join(dispatchHome, 'project-checkouts');
  const projectCp = createProjectCpService({ rootDir: managedRoot });
  const github = {
    configured: true,
    manifestRegistration() { throw new Error('not used'); },
    async completeManifest() { throw new Error('not used'); },
    installationUrl() { throw new Error('not used'); },
    authorizationUrl() { throw new Error('not used'); },
    async authorizeInstallation() { throw new Error('not used'); },
    async listRepositories() { return []; },
    async installationToken() { return ''; },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createProjectTaskWorkspaceRouter({ projectCp, github }));
  let downstreamCalls = 0;
  app.post('/api/tasks/:id/messages', (req, res) => {
    downstreamCalls += 1;
    const task = getTask(req.params.id);
    res.json({ workdir: task?.workdir ?? null });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  type Result = { status: number; body: Record<string, unknown> };
  const postMessage = (taskId: string, profile = 'default') => new Promise<Result>((resolve, reject) => {
    const payload = JSON.stringify({ content: 'Read AGENTS.md' });
    const req = request({
      host: '127.0.0.1', port: address.port,
      path: `/api/tasks/${taskId}/messages?profile=${encodeURIComponent(profile)}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  const unauthorized = await postMessage(firstTask.id, 'writer');
  assert.equal(unauthorized.status, 404);
  assert.equal(getProjectEditor(project.id), null, 'cross-profile request cannot create a repository lease');
  assert.equal(getTask(firstTask.id)?.workdir, null, 'cross-profile request cannot bind a workspace');
  assert.equal(downstreamCalls, 0, 'cross-profile request never reaches chat');

  const prepared = await postMessage(firstTask.id);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const workdir = String(prepared.body.workdir);
  assert.equal(workdir, join(managedRoot, project.id));
  assert.equal(await readFile(join(workdir, 'AGENTS.md'), 'utf8'), 'Thaweephan instructions\n');
  assert.equal(getProjectEditor(project.id)?.taskId, firstTask.id);
  assert.equal(getTask(firstTask.id)?.workdir, workdir);
  assert.equal(downstreamCalls, 1, 'chat starts only after repository preparation');

  const upstream = join(root, 'upstream');
  await execFile('git', ['clone', remote, upstream]);
  const protectedBranch = getProjectEditor(project.id)!.branchName;
  await git(workdir, ['push', 'origin', `HEAD:refs/heads/${protectedBranch}`]);
  await writeFile(join(upstream, 'AGENTS.md'), 'Updated Thaweephan instructions\n');
  await git(upstream, ['add', 'AGENTS.md']);
  await git(upstream, ['-c', 'user.name=Upstream', '-c', 'user.email=upstream@example.test', 'commit', '-m', 'Update instructions']);
  await git(upstream, ['push', 'origin', 'main']);
  await git(upstream, ['fetch', 'origin', `refs/heads/${protectedBranch}:refs/remotes/origin/${protectedBranch}`]);
  await git(upstream, ['checkout', '-b', protectedBranch, `origin/${protectedBranch}`]);
  await writeFile(join(upstream, 'GITHUB-SYNCED.md'), 'Protected branch update\n');
  await git(upstream, ['add', 'GITHUB-SYNCED.md']);
  await git(upstream, ['-c', 'user.name=Upstream', '-c', 'user.email=upstream@example.test', 'commit', '-m', 'Update protected branch']);
  await git(upstream, ['push', 'origin', protectedBranch]);

  const blocked = await postMessage(secondTask.id);
  assert.equal(blocked.status, 423, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'PROJECT_REPOSITORY_BUSY');
  assert.match(String(blocked.body.error), /Review AGENTS\.md/);
  assert.equal(getTask(secondTask.id)?.workdir, null);
  assert.equal(downstreamCalls, 1, 'a competing task never reaches Hermes with a fallback workspace');

  const { updateTask } = await import('../server/db/queries.js');
  updateTask(firstTask.id, { status: 'in_review' });

  await git(workdir, ['remote', 'set-url', 'origin', join(root, 'missing-remote.git')]);
  const failedHandoff = await postMessage(secondTask.id);
  assert.equal(failedHandoff.status, 503, JSON.stringify(failedHandoff.body));
  assert.equal(failedHandoff.body.code, 'PROJECT_REPOSITORY_PREPARE_FAILED');
  assert.equal(getProjectEditor(project.id)?.taskId, firstTask.id, 'failed sync preserves the current editor lease');
  assert.equal(getTask(firstTask.id)?.workdir, workdir, 'failed sync preserves the current task workspace');
  assert.equal(getTask(secondTask.id)?.workdir, null, 'failed sync never binds the next task');
  assert.equal(downstreamCalls, 1, 'failed sync never reaches Hermes');

  const current = getProjectEditor(project.id)!;
  assert.throws(() => transferProjectEditor({
    previousLeaseId: current.id,
    previousTaskId: firstTask.id,
    projectId: project.id,
    taskId: 'missing-task',
    profileId: 'default',
    repositoryFullName: 'leakim69/thaweephan',
    baseBranch: 'main',
    workdir,
    branchName: current.branchName,
    baseSha: current.baseSha,
    leaseToken: 'replacement-token',
  }), /FOREIGN KEY constraint failed|task was not found/);
  assert.equal(getProjectEditor(project.id)?.taskId, firstTask.id, 'failed transactional transfer restores the old lease');
  assert.equal(getTask(firstTask.id)?.workdir, workdir, 'failed transactional transfer restores the old workspace binding');

  await git(workdir, ['remote', 'set-url', 'origin', remote]);

  const handedOff = await postMessage(secondTask.id);
  assert.equal(handedOff.status, 200, JSON.stringify(handedOff.body));
  assert.equal(handedOff.body.workdir, workdir);
  assert.equal(await readFile(join(workdir, 'AGENTS.md'), 'utf8'), 'Updated Thaweephan instructions\n', 'a new task syncs the clean checkout from GitHub before it starts');
  assert.equal(await readFile(join(workdir, 'GITHUB-SYNCED.md'), 'utf8'), 'Protected branch update\n', 'a new task syncs the existing protected branch from GitHub');
  assert.equal(getProjectEditor(project.id)?.taskId, secondTask.id);
  assert.equal(getTask(firstTask.id)?.workdir, null, 'the reviewed task loses its old workspace binding');
  assert.equal(getTask(secondTask.id)?.workdir, workdir);
  assert.equal(downstreamCalls, 2, 'the next task starts only after clean automatic handoff');

  server.close();
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project task workspace route tests passed');
