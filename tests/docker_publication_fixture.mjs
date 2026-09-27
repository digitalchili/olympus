// Container-only acceptance fixture: compiled production services, local Git,
// and disposable SQLite state. The HTTP control surface belongs only to this test.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = '/fixture';
assert.equal(process.env.DB_PATH, `${root}/state/data/publication.db`);
assert.equal(process.env.OLYMPUS_DISPATCH_HOME, `${root}/state`);
await mkdir(`${root}/home`, { recursive: true });
await mkdir(`${root}/hermes`, { recursive: true });
const modules = '/opt/olympus-dispatch/dist/server/server';
const { createProjectCpService } = await import(`${modules}/project-cp.js`);
const { createProject, upsertProjectRepositoryLink } = await import(`${modules}/db/projects.js`);
const { upsertGitHubInstallation } = await import(`${modules}/db/studio-projects.js`);
const { insertTask } = await import(`${modules}/db/queries.js`);
const { listProjectVersions } = await import(`${modules}/db/project-cp.js`);
const { getProjectPublication } = await import(`${modules}/db/project-publications.js`);
const { default: db } = await import(`${modules}/db/index.js`);
// Keep pending writes in WAL until the real container crash; do not close/checkpoint.
db.pragma('wal_autocheckpoint = 0');
const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();
const bootId = randomUUID();
const manifestPath = `${root}/expected.json`;
const auditPath = `${root}/git-operations.jsonl`;
const originalMessage = 'Exact publication across container restart';
const laterWork = 'Uncommitted work created after the uncertain push\n';
const rootDir = `${root}/managed`;
let expected;
try { expected = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

async function runGit(cwd, args, options, allowPublication) {
  const mutation = args[0] === 'push' ? 'push' : args.includes('commit') ? 'commit' : null;
  if (mutation) {
    await appendFile(auditPath, `${JSON.stringify({ mutation, bootId })}\n`);
    assert.ok(allowPublication, 'Restart/retry must not repeat commit or push');
  }
  return run('git', args, { cwd, env: options?.env ?? process.env });
}

if (!expected) {
  const remote = `${root}/remote.git`;
  await git(root, 'init', '--bare', '-b', 'main', remote);
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Container publication', purpose: 'Crash acceptance', managerProfileId: 'default', changedBy: 'test' });
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, {
    id: 1, name: 'fixture', fullName: 'fixture/fixture', owner: 'fixture', private: true,
    defaultBranch: 'main', htmlUrl: 'https://example.invalid', cloneUrl: remote,
  });
  const task = insertTask({ title: 'Publication fixture', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const input = { projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink };
  const lease = await createProjectCpService({ rootDir }).prepareTask(input);
  await writeFile(join(lease.workdir, 'app.txt'), 'Original published bytes\n');
  let accepted = false;
  const lost = createProjectCpService({ rootDir, gitRunner: async (cwd, args, options) => {
    if (accepted && args[0] === 'ls-remote') throw new Error('Fixture: remote confirmation unavailable');
    const result = await runGit(cwd, args, options, true);
    if (args[0] === 'push') { accepted = true; throw new Error('Fixture: accepted push response lost'); }
    return result;
  } });
  await assert.rejects(lost.commitPush({ ...input, message: originalMessage }), { code: 'PUBLICATION_UNCONFIRMED' });
  assert.equal(accepted, true, 'The real bare Git remote must accept the original push');
  const pending = (await lost.status(input)).pendingPublication;
  assert.ok(pending, 'An uncertain accepted push must leave a pending publication');
  const receipt = getProjectPublication(pending.id);
  assert.equal(receipt.state, 'pending');
  assert.equal(receipt.commitSha, await git(remote, 'rev-parse', lease.branchName));
  await writeFile(join(lease.workdir, 'app.txt'), laterWork);
  expected = {
    initialBootId: bootId, input, lease, remote, pending, receipt,
    remoteRefs: await git(remote, 'for-each-ref', '--format=%(refname) %(objectname)'),
    remoteCommits: await git(remote, 'rev-list', '--all', '--count'),
  };
  await writeFile(manifestPath, JSON.stringify(expected));
}

const restarted = bootId !== expected.initialBootId;
const service = createProjectCpService({ rootDir, gitRunner: (cwd, args, options) => runGit(cwd, args, options, false) });

async function verify(state) {
  const status = await service.status(expected.input);
  const versions = listProjectVersions(expected.input.projectId);
  const receipt = getProjectPublication(expected.receipt.id);
  if (state === 'pending') {
    assert.deepEqual(status.pendingPublication, expected.pending, 'Restart must preserve the public pending receipt');
    assert.deepEqual(receipt, expected.receipt, 'Restart must preserve the complete immutable publication intent');
    assert.equal(versions.length, 0, 'Restart must not automatically finalize a pending publication');
  } else {
    assert.equal(status.pendingPublication, null);
    assert.equal(receipt.state, 'confirmed');
    assert.equal(versions.length, 1, 'Explicit retries must create only one version');
    assert.equal(versions[0].id, expected.receipt.id);
    assert.equal(versions[0].commitSha, expected.receipt.commitSha);
    assert.equal(versions[0].commitMessage, originalMessage);
    assert.equal(versions[0].branchName, expected.receipt.targetBranch);
    const { state: _state, completedAt: _completedAt, ...intent } = receipt;
    const { state: _oldState, completedAt: _oldCompletedAt, ...originalIntent } = expected.receipt;
    assert.deepEqual(intent, originalIntent, 'Confirmation must retain the original immutable intent');
  }
  assert.equal(await git(expected.remote, 'for-each-ref', '--format=%(refname) %(objectname)'), expected.remoteRefs, 'No remote ref may change after restart or retry');
  assert.equal(await git(expected.remote, 'rev-list', '--all', '--count'), expected.remoteCommits, 'No duplicate remote commit');
  assert.equal(await git(expected.lease.workdir, 'rev-parse', 'HEAD'), expected.receipt.commitSha, 'Original commit remains checked out');
  assert.equal(await readFile(join(expected.lease.workdir, 'app.txt'), 'utf8'), laterWork, 'Later uncommitted work must survive');
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.filter(row => row.mutation === 'commit').length, 1, 'Only the original publication commit ran');
  assert.equal(audit.filter(row => row.mutation === 'push').length, 1, 'Only the original accepted push ran');
  assert.ok(audit.every(row => row.bootId === expected.initialBootId), 'No publication may run on restart');
  return { state, restarted, commitSha: receipt.commitSha, commits: 1, pushes: 1, versions: versions.length, laterWorkPreserved: true };
}

await verify('pending');
let state = 'pending';
createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/retry') {
      assert.ok(restarted, 'The test must restart the container before explicitly retrying');
      const version = await service.retryPublication({ ...expected.input, publicationId: expected.receipt.id });
      assert.equal(version.id, expected.receipt.id);
      state = 'confirmed';
    } else {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/status');
    }
    const result = await verify(state);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) {
    // Do not print database rows, even though every value in this fixture is fake.
    console.error(`Publication fixture failed: ${error.message.split('\n')[0]}`);
    response.writeHead(500);
    response.end('Publication fixture assertion failed');
  }
}).listen(18080, '127.0.0.1', () => console.log(`Publication fixture ready: ${restarted ? 'restarted' : 'seeded'}`));
