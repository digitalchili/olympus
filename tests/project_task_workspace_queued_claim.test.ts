import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-queued-claim-'));
const dispatchHome = join(root, 'dispatch');
const hermesHome = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.HERMES_HOME = hermesHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'workspace-queued-claim.db');

try {
  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, 'profile.yaml'), 'displayName: Default\nactive: true\n');
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');

  const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
  const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
  const { insertTask } = await import('../server/db/queries.js');
  const { getQueuedTaskMessage, putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
  const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
  const { default: db } = await import('../server/db/index.js');

  const project = createProject({
    name: 'Queued Claim Project',
    purpose: 'Prove queued delivery claims before repository side effects',
    managerProfileId: 'default',
    changedBy: 'test',
  });
  upsertGitHubInstallation({ id: 177, accountLogin: 'example', accountType: 'User', permissionMode: 'read_write' });
  upsertProjectRepositoryLink(project.id, 177, {
    id: 42,
    name: 'repo',
    fullName: 'example/repo',
    owner: 'example',
    private: true,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/example/repo',
    cloneUrl: join(root, 'unused.git'),
  });
  const task = insertTask({
    title: 'Queued repo task',
    status: 'in_progress',
    project_id: project.id,
    profile_name: 'default',
    handling_profile_id: 'default',
  });
  const queuedContent = 'commit and push: feat: old queued checkpoint';
  putQueuedTaskMessage({
    id: 'queue-old',
    taskId: task.id,
    content: queuedContent,
    settings: { mode: 'task' },
    invitedProfileIds: [],
    collaborationScope: 'discussion',
    confirmPersistentCollaboration: false,
    createdAt: 100,
    updatedAt: 100,
  });

  let queueSeenByPrepare: string | undefined;
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createProjectTaskWorkspaceRouter({
    projectCp: {
      async prepareTask(input: { taskId: string }) {
        queueSeenByPrepare = getQueuedTaskMessage(input.taskId)?.id;
        putQueuedTaskMessage({
          id: 'queue-current',
          taskId: input.taskId,
          content: 'commit and push: feat: current queued checkpoint',
          settings: { mode: 'task' },
          invitedProfileIds: [],
          collaborationScope: 'discussion',
          confirmPersistentCollaboration: false,
          createdAt: 200,
          updatedAt: 200,
        });
        throw new Error('prepare failed after concurrent queue replacement');
      },
      async commitPush() { throw new Error('commitPush must not run after prepare failure'); },
      async releaseEditor() { throw new Error('releaseEditor must not run after prepare failure'); },
    } as never,
  }));
  app.post('/api/tasks/:id/messages', (_req, res) => res.status(500).json({ error: 'downstream chat must not run after prepare failure' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = JSON.stringify({ content: queuedContent, queuedMessageId: 'queue-old' });
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path: `/api/tasks/${task.id}/messages?profile=default`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });

  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(queueSeenByPrepare, undefined, 'repository preparation must run only after the queued row is claimed');
  assert.equal(getQueuedTaskMessage(task.id)?.id, 'queue-current', 'pre-start restore must not overwrite a newer queued replacement');

  server.close();
  await once(server, 'close');
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project task workspace queued claim test passed');
