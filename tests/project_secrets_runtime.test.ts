import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'olympus-secret-runtime-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const { default: db } = await import('../server/db/index.js');
const { createProject, grantProjectProfileAccess, revokeProjectProfileAccess } = await import('../server/db/projects.js');
const { insertTask, updateTask } = await import('../server/db/queries.js');
const { createProjectSecretsRuntime, runProjectCommand } = await import('../server/project-secrets-runtime.js');
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;
const cwd = join(root, 'work'); await mkdir(cwd);
const project = createProject({ name: 'First', purpose: 'Test local integration', managerProfileId: 'manager', changedBy: 'test' });
const other = createProject({ name: 'Second', purpose: 'Test isolation', managerProfileId: 'manager', changedBy: 'test' });
for (const p of [project, other]) grantProjectProfileAccess({ projectId: p.id, profileId: 'default', role: 'contribute', grantedBy: 'test' });
const task = insertTask({ title: 'Test', status: 'in_progress', profile_name: 'default', project_id: project.id, workdir: cwd });
const second = insertTask({ title: 'Other', status: 'in_progress', profile_name: 'default', project_id: other.id, workdir: cwd });
const secretA = 'first-value-$x"\nwith-newline';
const secretB = 'second-value-keep-private';
const request = (command: string, secrets = ['TEST_KEY']) => ({ requestId: 'request', workerRunId: 'run', command, secrets });
try {
  let lookups = 0;
  const runtime = createProjectSecretsRuntime({ values: (id, names) => {
    lookups++;
    if (names.length !== 1 || names[0] !== 'TEST_KEY') throw new Error('private unsafe error');
    return { TEST_KEY: id === project.id ? secretA : secretB };
  } });
  const before = process.env.TEST_KEY;
  const command = node(`const fs=require('fs'); fs.writeFileSync(process.env.TEST_KEY.startsWith('first')?'a.txt':'b.txt', process.env.TEST_KEY); console.log(process.env.TEST_KEY); console.log(Buffer.from(process.env.TEST_KEY).toString('base64')); console.log(JSON.stringify(process.env.TEST_KEY)); console.log(encodeURIComponent(process.env.TEST_KEY)); console.error(process.env.TEST_KEY);`);
  const results = await Promise.all([runtime.execute(task, request(command), () => true), runtime.execute(second, request(command), () => true)]);
  for (const [i, result] of results.entries()) {
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(i === 0 ? secretA : secretB), false);
    if (result.ok) assert.match(result.output, /\[redacted\]/);
  }
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), secretA);
  assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), secretB);
  assert.equal(process.env.TEST_KEY, before, 'child values never mutate server environment');
  // A process intentionally printing arbitrary pieces/encodings is not an isolation boundary.
  const failed = await runtime.execute(task, request(node(`process.stderr.write(process.env.TEST_KEY);process.exit(7)`)), () => true);
  assert.equal(failed.ok, true); if (failed.ok) { assert.equal(failed.exitCode, 7); assert.equal(failed.output, '[redacted]'); }
  process.env.OLYMPUS_FAKE_HOST_SECRET = 'must-not-inherit';
  const cleanEnv = await runtime.execute(task, request(node(`console.log(process.env.OLYMPUS_FAKE_HOST_SECRET || 'clean')`)), () => true);
  assert.equal(cleanEnv.ok, true); if (cleanEnv.ok) assert.equal(cleanEnv.output.trim(), 'clean');
  delete process.env.OLYMPUS_FAKE_HOST_SECRET;
  const bounded = await runProjectCommand(node(`process.stdout.write('x'.repeat(255999)+'boundary-secret'); setTimeout(()=>process.stdout.write('still running'),20)`), cwd, { TEST_KEY: 'boundary-secret' }, new AbortController().signal);
  assert.equal(bounded.ok, true); if (bounded.ok) { assert.equal(bounded.truncated, true); assert.equal(bounded.exitCode, 0); assert.equal(bounded.output.includes('boundary'), false); }
  const split = await runProjectCommand(node(`process.stdout.write('split-');setTimeout(()=>process.stdout.write('secret-value'),20)`), cwd, { TEST_KEY: 'split-secret-value' }, new AbortController().signal);
  assert.equal(split.ok, true); if (split.ok) assert.equal(split.output, '[redacted]');
  const interleaved = await runProjectCommand(node(`process.stdout.write('split-');setTimeout(()=>{process.stderr.write('benign warning');setTimeout(()=>process.stdout.write('secret-value'),20)},20)`), cwd, { TEST_KEY: 'split-secret-value' }, new AbortController().signal);
  assert.equal(interleaved.ok, true); if (interleaved.ok) {
    assert.equal(interleaved.output.includes('split-'), false);
    assert.equal(interleaved.output.includes('secret-value'), false);
    assert.match(interleaved.output, /benign warning/);
  }
  const beforeDenied = lookups;
  assert.equal((await runtime.execute(task, request('true'), () => false)).ok, false);
  grantProjectProfileAccess({ projectId: project.id, profileId: 'default', role: 'view', grantedBy: 'test' });
  assert.equal((await runtime.execute(task, request('true'), () => true)).ok, false);
  assert.equal(lookups, beforeDenied, 'denied task never decrypts a value');
  grantProjectProfileAccess({ projectId: project.id, profileId: 'default', role: 'contribute', grantedBy: 'test' });
  assert.equal((await runtime.execute(task, request('true', ['MISSING']), () => true)).ok, false);
  updateTask(task.id, { workdir: root });
  assert.equal((await runtime.execute(task, request('true'), () => true)).ok, false, 'stale workspace rejected');
  updateTask(task.id, { workdir: cwd });
  let started!: () => void; let aborted = false; let active = true;
  let startedPromise = new Promise<void>(resolve => { started = resolve; });
  const controlled = createProjectSecretsRuntime({ values: () => ({ TEST_KEY: 'private' }), run: async (_command, _cwd, _values, signal) => {
    started();
    return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, error: 'stopped' }); }, { once: true }));
  } });
  const stopped = controlled.execute(task, request('sleep 60'), () => active);
  await startedPromise; active = false;
  assert.equal((await stopped).ok, false); assert.equal(aborted, true);
  active = true; aborted = false; startedPromise = new Promise<void>(resolve => { started = resolve; });
  const revoked = controlled.execute(task, request('sleep 60'), () => active);
  await startedPromise; revokeProjectProfileAccess(project.id, 'default');
  assert.equal((await revoked).ok, false); assert.equal(aborted, true, 'revocation stops a pending command');
  const abort = new AbortController();
  const actual = runProjectCommand('sleep 60', cwd, { TEST_KEY: secretA }, abort.signal);
  const timer = setTimeout(() => abort.abort(), 30);
  try { assert.equal((await actual).ok, false); } finally { clearTimeout(timer); }
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Project secret runtime isolation, redaction, access and Stop tests passed');
