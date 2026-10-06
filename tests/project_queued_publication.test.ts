import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'queued-publication-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const seed = join(root, 'seed'), remote = join(root, 'remote.git');
await mkdir(join(seed, '.olympus'), { recursive: true });
await writeFile(join(seed, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }));
await writeFile(join(seed, 'app.txt'), 'original\n');
await git(seed, 'init', '-b', 'main');
await git(seed, 'add', '.');
await git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Initial');
await git(root, 'clone', '--bare', seed, remote);
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { createProjectCpService } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { startRun, discardRun } = await import('../server/live-chat.js');
const { createTaskAgentRun, finishTaskAgentRun } = await import('../server/db/task-agent-runs.js');
const { getQueuedTaskMessage, deleteQueuedTaskMessage, putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const { verifyCodingRun, readCodingEvidence } = await import('../server/coding-verification.js');
const { handleQueuedPublicationResponse } = await import('../server/queued-project-publication.js');
const { default: db } = await import('../server/db/index.js');
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Publish', purpose: 'Queue integration test', managerProfileId: 'default', changedBy: 'test' });
const link = upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'repo', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.test/repo', cloneUrl: remote });
let rejectPush = false;
const projectCp = createProjectCpService({ rootDir: join(root, 'projects'), gitRunner: async (cwd, args, options) => {
  if (rejectPush && args[0] === 'push') throw new Error('Disconnected');
  return promisify(execFile)('git', args, { cwd, env: options?.env ?? process.env });
} });
let background = { available: true, work: [] as unknown[] };
const app = express(); app.use(express.json());
app.use('/api/projects', createProjectsRouter({ projectCp, adapter: { getBackgroundWork: async () => background } as never }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const post = (body: unknown, profile = 'default') => fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/commit-push?profile=${profile}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function taskFixture() {
  const task = insertTask({ title: 'Publish repair', status: 'in_progress', project_id: project.id, profile_name: 'default' });
  const lease = await projectCp.prepareTask({ projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink: link });
  await writeFile(join(lease.workdir, 'app.txt'), `repair ${task.id}\n`);
  const { runId } = startRun(task.id, task.id, 'Yes, publish the repair to main').state;
  createTaskAgentRun({ taskId: task.id, runId, kind: 'chat', status: 'streaming', startedAt: Date.now() });
  return { task: getTask(task.id)!, runId, lease };
}
async function finish(f: Awaited<ReturnType<typeof taskFixture>>, status: 'done' | 'stopped' | 'error' = 'done') {
  await verifyCodingRun(f.task, f.runId);
  finishTaskAgentRun(f.runId, status, Date.now());
  discardRun(f.task.id); // Delivery must also work after the live snapshot expires/restart.
}
try {
  const f = await taskFixture();
  const before = await git(remote, 'rev-parse', 'main');
  const request = { taskId: f.task.id, message: 'Publish approved repair', deployToDefaultBranch: true };
  const response = await post(request); const accepted = await response.json();
  assert.equal(response.status, 202, JSON.stringify(accepted));
  assert.equal(accepted.action, 'publication_queued');
  const saved = getQueuedTaskMessage(f.task.id)!;
  assert.equal(saved.publication?.deployToDefaultBranch, true);
  assert.equal(await git(remote, 'rev-parse', 'main'), before, 'acceptance never mutates Git during the run');
  assert.equal((await post(request)).status, 202, 'repeated identical requests reuse the saved action');
  assert.equal(getQueuedTaskMessage(f.task.id)?.id, saved.id);
  const activeAttempt = await post({ taskId: f.task.id, queuedMessageId: saved.id });
  assert.equal(activeAttempt.status, 409);
  await assert.rejects(handleQueuedPublicationResponse(saved, activeAttempt));
  assert.equal(getQueuedTaskMessage(f.task.id)?.publication?.error, undefined, 'transient active operations remain queued');
  await finish(f);
  const delivered = await post({ taskId: f.task.id, queuedMessageId: saved.id });
  assert.equal(delivered.status, 200, await delivered.clone().text());
  assert.equal((await delivered.json()).action, 'commit_push');
  assert.equal(getQueuedTaskMessage(f.task.id), undefined);
  assert.notEqual(await git(remote, 'rev-parse', 'main'), before);
  assert.equal(await git(remote, 'show', 'main:app.txt'), `repair ${f.task.id}`);
  assert.equal((await post({ taskId: f.task.id, queuedMessageId: saved.id })).status, 409, 'a consumed request cannot publish twice');

  // A failed publication already owns a commit. Resume during a later chat must
  // wait for that chat, then retry that receipt without committing later edits.
  for (const outcome of ['done', 'stopped', 'cancelled', 'abandoned', 'profile', 'access', 'human follow-up'] as const) {
    const f = await taskFixture();
    await post({ taskId: f.task.id, message: 'Saved repair' });
    const first = getQueuedTaskMessage(f.task.id)!;
    await finish(f);
    rejectPush = true;
    assert.equal((await post({ taskId: f.task.id, queuedMessageId: first.id })).status, 503);
    rejectPush = false;
    const receipt = (await projectCp.status({ projectId: project.id, taskId: f.task.id })).pendingPublication!;
    const savedHead = await git(f.lease.workdir, 'rev-parse', 'HEAD');
    const { runId } = startRun(f.task.id, f.task.id, 'Resume publication').state;
    createTaskAgentRun({ taskId: f.task.id, runId, kind: 'chat', status: 'streaming', startedAt: Date.now() });
    const resume = (profile = 'default') => fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/publications/${receipt.id}/retry?profile=${profile}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: f.task.id }),
    });
    if (outcome === 'human follow-up') {
      putQueuedTaskMessage({ ...first, id: 'keep-human', content: 'Keep this', publication: undefined });
      assert.equal((await resume()).status, 409);
      assert.equal(getQueuedTaskMessage(f.task.id)?.id, 'keep-human');
      discardRun(f.task.id); deleteQueuedTaskMessage(f.task.id, 'keep-human'); continue;
    }
    if (outcome === 'profile') {
      assert.ok((await resume('unknown-profile')).status >= 400);
      assert.equal(getQueuedTaskMessage(f.task.id)?.id, first.id);
    }
    const accepted = await resume();
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const saved = getQueuedTaskMessage(f.task.id)!;
    assert.notEqual(saved.id, first.id);
    assert.equal(saved.publication?.publicationId, receipt.id);
    assert.equal((await resume()).status, 202, 'identical resume is idempotent');
    assert.equal(getQueuedTaskMessage(f.task.id)?.id, saved.id);
    await assert.rejects(git(remote, 'rev-parse', f.lease.branchName), 'no push during an active turn');
    await writeFile(join(f.lease.workdir, 'later.txt'), 'Keep this out of the saved publication');
    await finish({ ...f, runId }, outcome === 'stopped' ? 'stopped' : 'done');
    if (outcome === 'cancelled') deleteQueuedTaskMessage(f.task.id, saved.id);
    if (outcome === 'abandoned') await projectCp.abandonPublication({ projectId: project.id, taskId: f.task.id, publicationId: receipt.id });
    if (outcome === 'access') db.prepare("UPDATE project_repository_links SET mode = 'read_only' WHERE project_id = ?").run(project.id);
    const delivered = await post({ taskId: f.task.id, queuedMessageId: saved.id });
    assert.equal(await git(f.lease.workdir, 'rev-parse', 'HEAD'), savedHead, 'resume never creates a replacement commit');
    if (outcome === 'done' || outcome === 'profile') {
      assert.equal(delivered.status, 200, await delivered.clone().text());
      assert.equal(await git(remote, 'rev-parse', f.lease.branchName), savedHead);
      await assert.rejects(git(remote, 'show', `${savedHead}:later.txt`));
      assert.equal(getQueuedTaskMessage(f.task.id), undefined);
    } else {
      assert.ok(delivered.status >= 400, outcome);
      await assert.rejects(git(remote, 'rev-parse', f.lease.branchName));
      deleteQueuedTaskMessage(f.task.id, saved.id);
    }
    if (outcome === 'access') db.prepare("UPDATE project_repository_links SET mode = 'branch_pr' WHERE project_id = ?").run(project.id);
  }

  for (const cause of ['source changed', 'stopped', 'error', 'background work', 'background unavailable', 'write access revoked', 'cancelled', 'different profile', 'interrupted publication', 'failed checks', 'repository changed']) {
    const f = await taskFixture();
    assert.equal((await post({ taskId: f.task.id, message: 'Reviewed change' })).status, 202);
    const saved = getQueuedTaskMessage(f.task.id)!;
    await finish(f, cause === 'stopped' || cause === 'error' ? cause : 'done');
    if (cause === 'source changed') await writeFile(join(f.lease.workdir, 'app.txt'), 'later unapproved edit');
    if (cause === 'background work') background = { available: true, work: [{ id: 'child', status: 'running' }] };
    if (cause === 'background unavailable') background = { available: false, work: [] };
    if (cause === 'write access revoked') db.prepare("UPDATE project_repository_links SET mode = 'read_only' WHERE project_id = ?").run(project.id);
    if (cause === 'interrupted publication') { const { startQueuedPublication } = await import('../server/db/task-message-queue.js'); startQueuedPublication(f.task.id, saved.id); }
    if (cause === 'failed checks') db.prepare("UPDATE coding_evidence SET evidence_json = json_set(evidence_json, '$.status', 'failed') WHERE task_id = ?").run(f.task.id);
    if (cause === 'repository changed') db.prepare("UPDATE project_repository_links SET default_branch = 'another-branch' WHERE project_id = ?").run(project.id);
    if (cause === 'cancelled') deleteQueuedTaskMessage(f.task.id, saved.id);
    const before = await git(f.lease.workdir, 'rev-parse', 'HEAD');
    const result = await post({ taskId: f.task.id, queuedMessageId: saved.id }, cause === 'different profile' ? 'unknown-profile' : 'default');
    assert.ok(result.status >= 400, `${cause}: ${await result.clone().text()}`);
    assert.equal(await git(f.lease.workdir, 'rev-parse', 'HEAD'), before, `${cause} cannot commit`);
    if (['background work', 'background unavailable', 'write access revoked'].includes(cause)) {
      await assert.rejects(handleQueuedPublicationResponse(saved, result));
      assert.match(getQueuedTaskMessage(f.task.id)?.publication?.error ?? '', /Open Commit & Push/, `${cause} offers recovery instead of a silent queue`);
    }
    background = { available: true, work: [] };
    if (cause === 'write access revoked') db.prepare("UPDATE project_repository_links SET mode = 'branch_pr' WHERE project_id = ?").run(project.id);
    if (cause === 'repository changed') db.prepare("UPDATE project_repository_links SET default_branch = 'main' WHERE project_id = ?").run(project.id);
    deleteQueuedTaskMessage(f.task.id, saved.id);
  }

  const occupied = await taskFixture();
  const message = { id: 'human-followup', taskId: occupied.task.id, content: 'Keep my message', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion' as const, confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 };
  putQueuedTaskMessage(message);
  assert.equal((await post({ taskId: occupied.task.id, message: 'Save' })).status, 409);
  assert.deepEqual(getQueuedTaskMessage(occupied.task.id), message, 'publication cannot replace the human follow-up');
  discardRun(occupied.task.id);
  // Exercise the real chat settlement hook with a fake Hermes stream. No browser
  // or second agent turn should be needed to dispatch the saved action.
  const { default: liveApp, adapter } = await import('../server/app.js');
  const { createQueuedMessageDispatcher, configureQueuedMessageDispatcher } = await import('../server/queued-message-dispatcher.js');
  const { getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
  for (const mode of ['new', 'verified', 'resume']) {
    const alreadyVerified = mode === 'verified';
    await projectCp.sync({ projectId: project.id, repositoryLink: link });
    const automatic = insertTask({ title: 'Automatic publication', status: 'in_progress', project_id: project.id, profile_name: 'default' });
    const automaticLease = await projectCp.prepareTask({ projectId: project.id, taskId: automatic.id, profileId: 'default', repositoryLink: link });
    const approvedText = `automatic approved repair ${mode}`;
    await writeFile(join(automaticLease.workdir, 'app.txt'), approvedText);
    if (alreadyVerified) assert.equal(await verifyCodingRun(getTask(automatic.id)!, 'implementation'), true);
    let resumeId: string | undefined;
    if (mode === 'resume') {
      rejectPush = true;
      await assert.rejects(projectCp.commitPush({ projectId: project.id, taskId: automatic.id, repositoryLink: link, message: 'Saved automatic repair', deployToDefaultBranch: true }));
      rejectPush = false;
      resumeId = (await projectCp.status({ projectId: project.id, taskId: automatic.id })).pendingPublication!.id;
    }
    let agentTurns = 0;
    let resolvePublished!: () => void;
    let rejectPublished!: (error: Error) => void;
    const published = new Promise<void>((resolve, reject) => { resolvePublished = resolve; rejectPublished = reject; });
    const dispatcher = createQueuedMessageDispatcher({
      load: getQueuedTaskMessage,
      isActive: taskId => getLatestTaskAgentRun(taskId)?.status !== 'done',
      deliver: async (taskId, message) => {
        const result = await post({ taskId, queuedMessageId: message.id });
        await handleQueuedPublicationResponse(message, result);
        resolvePublished();
      },
      onError: (_taskId, error) => rejectPublished(error as Error),
    });
    configureQueuedMessageDispatcher(dispatcher);
    adapter.getBackgroundWork = async () => ({ available: true, work: [] });
    adapter.chatStream = async function* (sessionId) {
      agentTurns++;
      const response = resumeId
        ? await fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/publications/${resumeId}/retry?profile=default`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: sessionId }),
        })
        : await post({ taskId: sessionId, message: 'Approved automatic repair', deployToDefaultBranch: true });
      assert.equal(response.status, 202, await response.text());
      yield { type: 'text_delta' as const, delta: 'Publication queued. Finishing this turn.' };
      yield { type: 'done' as const, sessionId };
    };
    const liveServer = liveApp.listen(0, '127.0.0.1'); await once(liveServer, 'listening');
    const liveAddress = liveServer.address(); assert.ok(liveAddress && typeof liveAddress === 'object');
    const timeout = setTimeout(() => rejectPublished(new Error('Automatic publication did not finish')), 15_000);
    try {
      const response = await fetch(`http://127.0.0.1:${liveAddress.port}/api/tasks/${automatic.id}/messages?profile=default`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Yes, of course' }),
      });
      assert.equal(response.status, 202, await response.text());
      await published;
      assert.equal(agentTurns, 1, 'publication must not launch another Hermes turn');
      assert.equal(await git(remote, 'show', 'main:app.txt'), approvedText);
      assert.equal(getQueuedTaskMessage(automatic.id), undefined);
      assert.equal(getTask(automatic.id)?.status, 'in_review', 'approval finishes in review with fresh or reused verification');
      if (mode === 'resume') assert.equal((await readCodingEvidence(getTask(automatic.id)!))?.status, 'skipped', 'an unchanged resume turn does not force unrelated checks');
    } finally {
      clearTimeout(timeout);
      liveServer.close(); await once(liveServer, 'close'); discardRun(automatic.id);
    }
  }
  console.log('Queued Project publication: active-run handoff, exact target/source, cancellation, failure and scope regressions passed');
} finally {
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
