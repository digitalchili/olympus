import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitRunner } from '../server/project-cp.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-publication-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const runner: GitRunner = (cwd, args, options) => run('git', args, { cwd, env: options?.env ?? process.env });
const { createProjectCpService } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { listProjectVersions } = await import('../server/db/project-cp.js');
const { default: db } = await import('../server/db/index.js');
let fixtureId = 0;
async function fixture() {
  const id = ++fixtureId;
  const remote = join(root, `remote-${id}.git`);
  await git(root, 'init', '--bare', '-b', 'main', remote);
  const project = createProject({ name: `Publication ${id}`, purpose: 'Recovery', managerProfileId: 'default', changedBy: 'test' });
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, { id, name: `repo-${id}`, fullName: `fixture/repo-${id}`, owner: 'fixture', private: true, defaultBranch: 'main', htmlUrl: 'https://example.invalid', cloneUrl: remote });
  const task = insertTask({ title: 'Publish', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const input = { projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink };
  const rootDir = join(root, `managed-${id}`);
  const service = createProjectCpService({ rootDir });
  const lease = await service.prepareTask(input);
  await writeFile(join(lease.workdir, 'app.txt'), 'original publication\n');
  return { remote, input, rootDir, service, lease };
}

try {
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const promotion = await fixture();
  const published = await promotion.service.commitPush({ ...promotion.input, message: 'Reviewed task change' });
  const clean = await promotion.service.status(promotion.input);
  assert.equal(clean.clean, true, 'a published task branch keeps clean workspace semantics');
  assert.notEqual(await git(promotion.remote, 'rev-parse', 'main'), published.commitSha);
  await assert.rejects(promotion.service.commitPush({ ...promotion.input, message: 'Duplicate branch push' }), /no changes/i);
  const promoted = await promotion.service.commitPush({ ...promotion.input, message: 'Promotion request', deployToDefaultBranch: true });
  assert.equal(promoted.commitSha, published.commitSha, 'promotion must reuse the published commit');
  assert.equal(promoted.commitMessage, published.commitMessage);
  assert.deepEqual(promoted.changedFiles, published.changedFiles);
  assert.equal(promoted.branchName, 'main');
  assert.equal(await git(promotion.remote, 'rev-parse', 'main'), published.commitSha);
  assert.equal(await git(promotion.lease.workdir, 'rev-parse', 'HEAD'), published.commitSha, 'no empty promotion commit');
  assert.equal(clean.defaultBranchPromotion?.commitSha, published.commitSha);
  assert.equal((await promotion.service.status(promotion.input)).defaultBranchPromotion, undefined);
  await assert.rejects(promotion.service.commitPush({ ...promotion.input, message: 'Already promoted', deployToDefaultBranch: true }), /no changes/i);

  const cleanRace = await fixture();
  const raceVersion = await cleanRace.service.commitPush({ ...cleanRace.input, message: 'Task checkpoint' });
  const concurrent = join(root, 'promotion-race');
  await git(root, 'clone', cleanRace.remote, concurrent);
  await writeFile(join(concurrent, 'other.txt'), 'Another task');
  await git(concurrent, 'add', '.');
  await git(concurrent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Other task');
  await git(concurrent, 'push', 'origin', 'main');
  const concurrentMain = await git(cleanRace.remote, 'rev-parse', 'main');
  await assert.rejects(cleanRace.service.commitPush({ ...cleanRace.input, message: 'Promote', deployToDefaultBranch: true }), (error: any) => error.code === 'PUBLICATION_CONFLICT');
  assert.equal(await git(cleanRace.remote, 'rev-parse', 'main'), concurrentMain, 'promotion never overwrites newer main');
  assert.equal(await git(cleanRace.remote, 'rev-parse', cleanRace.lease.branchName), raceVersion.commitSha);
  assert.equal((await cleanRace.service.status(cleanRace.input)).pendingPublication?.failureReason, 'branch_advanced');

  const f = await fixture();
  let accepted = false;
  const lost = createProjectCpService({ rootDir: f.rootDir, gitRunner: async (cwd, args, options) => {
    if (accepted && args[0] === 'ls-remote') throw new Error('confirmation unavailable');
    const result = await runner(cwd, args, options);
    if (args[0] === 'push') { accepted = true; throw new Error('lost accepted push response'); }
    return result;
  } });
  await assert.rejects(lost.commitPush({ ...f.input, message: 'Exact original message' }));
  const remoteSha = await git(f.remote, 'rev-parse', f.lease.branchName);
  assert.equal(await git(f.lease.workdir, 'rev-parse', 'HEAD'), remoteSha, 'accepted but unconfirmed publication must retain its exact commit');
  const pending = (await lost.status(f.input)).pendingPublication!;
  assert.equal(pending.commitSha, remoteSha);
  assert.deepEqual(pending.targetBranches.sort(), [f.lease.branchName, 'main'].sort());
  assert.equal(listProjectVersions(f.input.projectId).length, 0);
  await assert.rejects(lost.releaseEditor(f.input), /publication/i);
  await assert.rejects(lost.commitPush({ ...f.input, message: 'Replacement', deployToDefaultBranch: true }), /publication/i);
  await writeFile(join(f.lease.workdir, 'app.txt'), 'new unsaved work\n');
  const restarted = createProjectCpService({ rootDir: f.rootDir, gitRunner: async (cwd, args, options) => {
    assert.notEqual(args[0], 'push', 'matching refs finalize without another push');
    return runner(cwd, args, options);
  } });
  const retry = { ...f.input, publicationId: pending.id };
  const version = await restarted.retryPublication(retry);
  assert.equal(version.id, pending.id);
  assert.equal(version.commitSha, remoteSha);
  assert.equal(version.commitMessage, 'Exact original message');
  assert.equal(await readFile(join(f.lease.workdir, 'app.txt'), 'utf8'), 'new unsaved work\n');
  assert.equal((await restarted.retryPublication(retry)).id, version.id);
  assert.equal(listProjectVersions(f.input.projectId).length, 1);
  assert.equal((await restarted.status(f.input)).pendingPublication, null);
  const partial = await fixture();
  let sent = false;
  const uncertain = createProjectCpService({ rootDir: partial.rootDir, gitRunner: async (cwd, args, options) => {
    if (sent && args[0] === 'ls-remote') throw new Error('unreachable confirmation');
    const result = await runner(cwd, args, options);
    if (args[0] === 'push') { sent = true; throw new Error('lost response'); }
    return result;
  } });
  await assert.rejects(uncertain.commitPush({ ...partial.input, message: 'Two distinct source refs' }));
  const partialReceipt = (await uncertain.status(partial.input)).pendingPublication!;
  await git(partial.remote, 'update-ref', 'refs/heads/main', partialReceipt.commitSha!);
  await assert.rejects(partial.service.retryPublication({ ...partial.input, publicationId: partialReceipt.id }), /conflicts/);
  assert.equal(listProjectVersions(partial.input.projectId).length, 0, 'matching task ref cannot confirm a different saved default ref');
  assert.equal(await git(partial.lease.workdir, 'rev-parse', 'HEAD'), partialReceipt.commitSha);

  const advancing = await fixture();
  let concurrentHead = '';
  const racingPush = createProjectCpService({ rootDir: advancing.rootDir, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'push') {
      const other = join(root, 'task-branch-race');
      await git(root, 'clone', advancing.lease.workdir, other);
      await writeFile(join(other, 'concurrent.txt'), 'Concurrent task branch');
      await git(other, 'add', '.');
      await git(other, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Concurrent task branch');
      concurrentHead = await git(other, 'rev-parse', 'HEAD');
      await git(other, 'push', advancing.remote, `HEAD:refs/heads/${advancing.lease.branchName}`);
    }
    return runner(cwd, args, options);
  } });
  await assert.rejects(racingPush.commitPush({ ...advancing.input, message: 'Never rewind another writer' }));
  assert.equal(await git(advancing.remote, 'rev-parse', advancing.lease.branchName), concurrentHead, 'create-only default lease must not force the task branch');
  await assert.rejects(git(advancing.remote, 'rev-parse', 'main'), 'atomic failure leaves default absent');

  // Each interruption is followed by a fresh service instance, as after restart.
  for (const phase of ['before_commit', 'after_commit'] as const) {
    const crash = await fixture();
    let interrupted = false;
    const stopped = createProjectCpService({ rootDir: crash.rootDir, gitRunner: async (cwd, args, options) => {
      if (args.includes('commit') && !interrupted) {
        interrupted = true;
        if (phase === 'after_commit') await runner(cwd, args, options);
        throw new Error('process lost at commit boundary');
      }
      return runner(cwd, args, options);
    } });
    await assert.rejects(stopped.commitPush({ ...crash.input, message: `Saved ${phase}`, deployToDefaultBranch: true }));
    const receipt = (await stopped.status(crash.input)).pendingPublication!;
    assert.equal(receipt.state, 'prepared');
    assert.equal(receipt.commitSha, null);
    const retainedHead = await git(crash.lease.workdir, 'rev-parse', 'HEAD');
    let commits = 0;
    const resumed = createProjectCpService({ rootDir: crash.rootDir, gitRunner: async (cwd, args, options) => {
      if (args.includes('commit')) commits++;
      return runner(cwd, args, options);
    } });
    const saved = await resumed.retryPublication({ ...crash.input, publicationId: receipt.id });
    assert.equal(saved.commitMessage, `Saved ${phase}`);
    assert.equal(saved.branchName, 'main');
    assert.equal(commits, phase === 'after_commit' ? 0 : 1, 'restart adopts an already-created matching commit');
    if (phase === 'after_commit') assert.equal(saved.commitSha, retainedHead);
    assert.equal(await git(crash.remote, 'rev-parse', 'main'), saved.commitSha);
    assert.equal(await git(crash.remote, 'rev-parse', crash.lease.branchName), saved.commitSha);
    await resumed.releaseEditor(crash.input);
    assert.equal((await resumed.retryPublication({ ...crash.input, publicationId: receipt.id })).id, saved.id, 'confirmed retry is read-only even after release');
  }

  // main can advance via a merge while a task continues on its original branch.
  // Git rejection is actionable, not an uncertain network outcome.
  const diverged = await fixture();
  const firstVersion = await diverged.service.commitPush({ ...diverged.input, message: 'Initial task' });
  const other = join(root, 'main-merge');
  await git(root, 'clone', diverged.remote, other);
  await git(other, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '-m', 'Merge task', firstVersion.commitSha);
  await git(other, 'push', 'origin', 'main');
  const mainBefore = await git(diverged.remote, 'rev-parse', 'main');
  await writeFile(join(diverged.lease.workdir, 'app.txt'), 'Follow-up repair');
  await assert.rejects(diverged.service.commitPush({ ...diverged.input, message: 'Repair', deployToDefaultBranch: true }), (error: any) => {
    assert.equal(error.code, 'PUBLICATION_CONFLICT');
    assert.match(error.message, /branch has advanced.*merge/i);
    assert.doesNotMatch(error.message, /could not be confirmed/);
    return true;
  });
  const conflict = (await diverged.service.status(diverged.input)).pendingPublication!;
  assert.equal(conflict.failureReason, 'branch_advanced', 'the reason survives status refresh');
  assert.match((await diverged.service.status(diverged.input)).summary, /branch has advanced/);
  assert.equal(await git(diverged.remote, 'rev-parse', 'main'), mainBefore);
  assert.equal(await git(diverged.remote, 'rev-parse', diverged.lease.branchName), firstVersion.commitSha, 'atomic rejection cannot partly publish');
  assert.equal(await git(diverged.lease.workdir, 'rev-parse', 'HEAD'), conflict.commitSha);
  await assert.rejects(diverged.service.retryPublication({ ...diverged.input, publicationId: conflict.id }), { code: 'PUBLICATION_CONFLICT' });

  const rejected = await fixture();
  const rejecting = createProjectCpService({ rootDir: rejected.rootDir, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'push') throw new Error('definite pre-send rejection, unsafe detail');
    return runner(cwd, args, options);
  } });
  await assert.rejects(rejecting.commitPush({ ...rejected.input, message: 'Retain rejected SHA' }), /could not be confirmed/);
  const rejectedReceipt = (await rejecting.status(rejected.input)).pendingPublication!;
  const rejectedHead = await git(rejected.lease.workdir, 'rev-parse', 'HEAD');
  const forbidden = createProjectCpService({ rootDir: rejected.rootDir, gitRunner: async () => { assert.fail('wrong repository must fail before Git or token requests'); } });
  await assert.rejects(forbidden.retryPublication({ ...rejected.input, publicationId: rejectedReceipt.id,
    repositoryLink: { ...rejected.input.repositoryLink, defaultBranch: 'other' }, tokenProvider: async () => { assert.fail('no token'); } }), /publication/i);
  await writeFile(join(rejected.lease.workdir, 'later.txt'), 'Preserved after rejection');
  const retried = await rejected.service.retryPublication({ ...rejected.input, publicationId: rejectedReceipt.id });
  assert.equal(retried.commitSha, rejectedHead);
  assert.equal(await readFile(join(rejected.lease.workdir, 'later.txt'), 'utf8'), 'Preserved after rejection');
  await assert.rejects(git(rejected.remote, 'show', `${retried.commitSha}:later.txt`), 'retry must not stage new work');

  const mismatch = await fixture();
  const beforeCommit = createProjectCpService({ rootDir: mismatch.rootDir, gitRunner: async (cwd, args, options) => {
    if (args.includes('commit')) throw new Error('interrupted');
    return runner(cwd, args, options);
  } });
  await assert.rejects(beforeCommit.commitPush({ ...mismatch.input, message: 'Prepared tree' }));
  const mismatchReceipt = (await beforeCommit.status(mismatch.input)).pendingPublication!;
  await writeFile(join(mismatch.lease.workdir, 'app.txt'), 'new staged work');
  await git(mismatch.lease.workdir, 'add', '.');
  await assert.rejects(mismatch.service.retryPublication({ ...mismatch.input, publicationId: mismatchReceipt.id }), /publication/i);
  const headBeforeAbandon = await git(mismatch.lease.workdir, 'rev-parse', 'HEAD');
  const abandon = createProjectCpService({ rootDir: mismatch.rootDir, gitRunner: async () => { assert.fail('abandon does no Git or network work'); } });
  await abandon.abandonPublication({ ...mismatch.input, publicationId: mismatchReceipt.id });
  assert.equal(await git(mismatch.lease.workdir, 'rev-parse', 'HEAD'), headBeforeAbandon);
  assert.equal(await readFile(join(mismatch.lease.workdir, 'app.txt'), 'utf8'), 'new staged work');
  assert.equal((await mismatch.service.status(mismatch.input)).pendingPublication, null);

  const finalize = await fixture();
  db.exec("CREATE TEMP TRIGGER fail_publication_confirmation BEFORE UPDATE OF state ON project_publications WHEN NEW.state = 'confirmed' BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END");
  await assert.rejects(finalize.service.commitPush({ ...finalize.input, message: 'Database interrupted' }));
  const finalReceipt = (await finalize.service.status(finalize.input)).pendingPublication!;
  assert.equal(listProjectVersions(finalize.input.projectId).length, 0);
  db.exec('DROP TRIGGER fail_publication_confirmation');
  const finalizer = createProjectCpService({ rootDir: finalize.rootDir, gitRunner: async (cwd, args, options) => {
    assert.notEqual(args[0], 'push', 'remote confirmation repairs the interrupted DB transaction without push');
    return runner(cwd, args, options);
  } });
  assert.equal((await finalizer.retryPublication({ ...finalize.input, publicationId: finalReceipt.id })).commitSha, finalReceipt.commitSha);

  const restore = await fixture();
  const original = await restore.service.commitPush({ ...restore.input, message: 'Original' });
  await writeFile(join(restore.lease.workdir, 'app.txt'), 'second publication');
  await restore.service.commitPush({ ...restore.input, message: 'Second' });
  const interruptedRestore = createProjectCpService({ rootDir: restore.rootDir, gitRunner: async (cwd, args, options) => {
    if (args.includes('commit')) throw new Error('interrupted after restoring the tree');
    return runner(cwd, args, options);
  } });
  await assert.rejects(interruptedRestore.revert({ ...restore.input, versionId: original.id }));
  const restoreReceipt = (await interruptedRestore.status(restore.input)).pendingPublication!;
  assert.equal(restoreReceipt.action, 'revert');
  const restored = await restore.service.retryPublication({ ...restore.input, publicationId: restoreReceipt.id });
  assert.equal(restored.action, 'revert');
  assert.equal(restored.revertedVersionId, original.id);
  assert.equal(await readFile(join(restore.lease.workdir, 'app.txt'), 'utf8'), 'original publication\n');
  assert.notEqual(restored.commitSha, original.commitSha, 'restore is a new history commit');
  await writeFile(join(restore.lease.workdir, 'app.txt'), 'third publication');
  const third = await restore.service.commitPush({ ...restore.input, message: 'Third' });
  const partialRestore = createProjectCpService({ rootDir: restore.rootDir, gitRunner: async (cwd, args, options) => {
    const result = await runner(cwd, args, options);
    if (args[0] === 'restore') {
      await writeFile(join(cwd, 'app.txt'), 'partial restored worktree');
      throw new Error('process lost during restore');
    }
    return result;
  } });
  await assert.rejects(partialRestore.revert({ ...restore.input, versionId: original.id }));
  const partialRestoreReceipt = (await partialRestore.status(restore.input)).pendingPublication!;
  await assert.rejects(restore.service.retryPublication({ ...restore.input, publicationId: partialRestoreReceipt.id }), /publication/i);
  assert.equal(await git(restore.lease.workdir, 'rev-parse', 'HEAD'), third.commitSha);
  assert.equal(await readFile(join(restore.lease.workdir, 'app.txt'), 'utf8'), 'partial restored worktree');
  console.log('Publication recovery: response loss, both commit crash boundaries, rejection, immutable target/SHA, changed index refusal, local abandon, DB repair, revert and idempotency passed');
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
