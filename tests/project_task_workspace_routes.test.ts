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
  const { deleteQueuedTaskMessage, getQueuedTaskMessage, putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
  const { getProjectEditor, getProjectEditorForTask, listProjectEditors } = await import('../server/db/project-cp.js');
  const { createProjectCpService } = await import('../server/project-cp.js');
  const { createTaskRecoveryRouter } = await import('../server/routes/task-recovery.js');
  const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
  const { createProjectsRouter } = await import('../server/routes/projects.js');
  const { discardRun, startRun } = await import('../server/live-chat.js');
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
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, {
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
  app.use('/api/tasks', createTaskRecoveryRouter({ getBackgroundWork: async () => ({ available:true, work:[] }) }));
  app.use('/api/tasks', createProjectTaskWorkspaceRouter({ projectCp, github }));
  app.use('/api/projects', createProjectsRouter({ projectCp, github, adapter: { getBackgroundWork: async () => ({available:true,work:[]}) } as never }));
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
  const postMessage = (taskId: string, profile = 'default', content = 'Read AGENTS.md', queuedMessageId?: string) => new Promise<Result>((resolve, reject) => {
    const payload = JSON.stringify({ content, ...(queuedMessageId ? { queuedMessageId } : {}) });
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
  let workdir = String(prepared.body.workdir);
  assert.ok(workdir.startsWith(managedRoot));
  assert.equal(await readFile(join(workdir, 'AGENTS.md'), 'utf8'), 'Thaweephan instructions\n');
  assert.equal(getProjectEditor(project.id)?.taskId, firstTask.id);
  assert.equal(getTask(firstTask.id)?.workdir, workdir);
  assert.equal(downstreamCalls, 1, 'chat starts only after repository preparation');

  const firstWorkdir = workdir;
  await writeFile(join(firstWorkdir, 'SAVED-WORK.md'), 'Unpublished work belongs only to task one\n');
  startRun(firstTask.id, firstTask.id, 'Still developing');
  const second = await postMessage(secondTask.id);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  workdir = String(second.body.workdir);
  assert.notEqual(workdir, firstWorkdir, 'active and dirty task one does not own task two’s workspace');
  assert.notEqual(getProjectEditorForTask(project.id, firstTask.id)!.branchName, getProjectEditorForTask(project.id, secondTask.id)!.branchName);
  assert.equal(listProjectEditors(project.id).length, 2);
  assert.equal(getTask(firstTask.id)?.workdir, firstWorkdir);
  assert.equal(await readFile(join(firstWorkdir, 'SAVED-WORK.md'), 'utf8'), 'Unpublished work belongs only to task one\n');
  await assert.rejects(readFile(join(workdir, 'SAVED-WORK.md')), /ENOENT/);
  assert.equal(downstreamCalls, 2);
  discardRun(firstTask.id);
  const resumed = await postMessage(firstTask.id);
  assert.equal(resumed.body.workdir, firstWorkdir, 'returning to task one resumes its exact saved workspace');
  assert.equal(await readFile(join(firstWorkdir, 'SAVED-WORK.md'), 'utf8'), 'Unpublished work belongs only to task one\n');
  const publicEditors = await (await fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/editors?profile=default`)).json();
  assert.equal(publicEditors.editors.length, 2);
  assert.ok(publicEditors.editors.every((editor: any) => !('workdir' in editor)));
  const exactEditor = await (await fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/editor?taskId=${secondTask.id}&profile=default`)).json();
  assert.equal(exactEditor.editor.taskId, secondTask.id);

  await writeFile(join(workdir, 'TASK-WINDOW-COMMIT.md'), 'Committed from task chat\n');
  startRun(secondTask.id, secondTask.id, 'Work is still in progress');
  const busyCommit = await postMessage(secondTask.id, 'default', 'commit and push: must wait for the active run');
  assert.equal(busyCommit.status, 409, JSON.stringify(busyCommit.body));
  assert.match(await git(workdir, ['status', '--porcelain']), /TASK-WINDOW-COMMIT\.md/, 'an active run prevents an in-flight commit');
  discardRun(secondTask.id);

  const queuedContent = 'commit and push: feat: queued task-window checkpoint';
  await writeFile(join(workdir, 'QUEUED-COMMIT.md'), 'Committed from a durable queue\n');
  putQueuedTaskMessage({
    id: 'queue-commit-1',
    taskId: secondTask.id,
    content: queuedContent,
    settings: { mode: 'task' },
    invitedProfileIds: [],
    collaborationScope: 'discussion',
    confirmPersistentCollaboration: false,
    createdAt: 40_000,
    updatedAt: 40_000,
  });
  const queuedCommit = await postMessage(secondTask.id, 'default', queuedContent, 'queue-commit-1');
  assert.equal(queuedCommit.status, 200, JSON.stringify(queuedCommit.body));
  assert.equal(getQueuedTaskMessage(secondTask.id), undefined, 'a successful queued commit is consumed exactly once');
  assert.equal((await git(workdir, ['status', '--porcelain'])), '');

  const noChangesContent = 'commit and push: test queued restore';
  putQueuedTaskMessage({
    id: 'queue-no-changes',
    taskId: secondTask.id,
    content: noChangesContent,
    settings: { mode: 'task' },
    invitedProfileIds: [],
    collaborationScope: 'discussion',
    confirmPersistentCollaboration: false,
    createdAt: 41_000,
    updatedAt: 41_000,
  });
  const failedQueuedCommit = await postMessage(secondTask.id, 'default', noChangesContent, 'queue-no-changes');
  assert.equal(failedQueuedCommit.status, 409, JSON.stringify(failedQueuedCommit.body));
  assert.equal(getQueuedTaskMessage(secondTask.id)?.id, 'queue-no-changes', 'a failed queued commit is restored for retry');

  await writeFile(join(workdir, 'STALE-QUEUE.md'), 'Must not be committed by a stale queue request\n');
  putQueuedTaskMessage({
    id: 'queue-current',
    taskId: secondTask.id,
    content: 'commit and push: current queue item',
    settings: { mode: 'task' },
    invitedProfileIds: [],
    collaborationScope: 'discussion',
    confirmPersistentCollaboration: false,
    createdAt: 42_000,
    updatedAt: 42_000,
  });
  const staleQueuedCommit = await postMessage(secondTask.id, 'default', 'commit and push: stale queue item', 'queue-no-changes');
  assert.equal(staleQueuedCommit.status, 409, JSON.stringify(staleQueuedCommit.body));
  assert.equal(getQueuedTaskMessage(secondTask.id)?.id, 'queue-current', 'a stale request cannot consume its replacement');
  assert.match(await git(workdir, ['status', '--porcelain']), /STALE-QUEUE\.md/, 'a stale request cannot perform the commit');

  assert.equal(deleteQueuedTaskMessage(secondTask.id, 'queue-current'), true);
  const committed = await postMessage(secondTask.id, 'default', 'commit and push: feat: task-window checkpoint');
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.action, 'commit_push');
  assert.equal((committed.body.version as Record<string, unknown>).commitMessage, 'feat: task-window checkpoint');
  assert.equal((committed.body.version as Record<string, unknown>).changedFiles instanceof Array, true);
  assert.equal(downstreamCalls, 3, 'commit commands are handled before Hermes chat');
  assert.equal((await git(workdir, ['status', '--porcelain'])), '');
  assert.equal(getProjectEditorForTask(project.id, secondTask.id), null, 'a successful task-chat commit releases only this task’s active editor');
  assert.equal(getProjectEditorForTask(project.id, firstTask.id)?.workdir, firstWorkdir, 'another task keeps its editor and saved work');
  assert.equal(getTask(secondTask.id)?.workdir, workdir, 'the task keeps its durable workspace after publication');
  assert.equal(getTask(secondTask.id)?.status, 'in_review', 'a successful task-chat commit hands the task to review');

  server.close();
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project task workspace route tests passed');
