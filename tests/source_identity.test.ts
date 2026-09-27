import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, chmod, stat, utimes, symlink, unlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineSnapshot } from './fixtures/source-identity-oracle.js';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const root = await mkdtemp(join(tmpdir(), 'source-identity-'));
process.env.DB_PATH = join(root, 'db'); process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const verification = await import('../server/coding-verification.js');
const cwd = join(root, 'repo'); await mkdir(cwd);
const exec = promisify(execFile);
const git = (...args: string[]) => exec('git', args, { cwd });
try {
  assert.equal(typeof (verification as any).sourceIdentity, 'function', 'Export an identity-only reader');
  const { sourceIdentity, sourceSnapshot, captureCodingBaseline, readCodingEvidence } = verification;
  await git('init'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Fixture');
  await writeFile(join(cwd, 'tracked.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'Original');
  const fingerprints = new Map<string, string>();
  async function check(label: string) {
    const oracle = await baselineSnapshot(cwd);
    const identity = await sourceIdentity(cwd);
    assert.deepEqual(identity, { head: oracle.head, fingerprint: oracle.fingerprint }, `${label}: frozen 9ba0fd6 algorithm`);
    assert.deepEqual(await sourceSnapshot(cwd), oracle, `${label}: full diagnostics remain unchanged`);
    fingerprints.set(label, identity.fingerprint);
  }
  await check('clean');
  const metadata = await stat(join(cwd, 'tracked.txt'));
  await writeFile(join(cwd, 'tracked.txt'), 'modified');
  await utimes(join(cwd, 'tracked.txt'), metadata.atime, metadata.mtime);
  await check('same-length-restored-mtime');
  assert.notEqual(fingerprints.get('clean'), fingerprints.get('same-length-restored-mtime'));
  await git('add', '.'); await check('staged');
  await writeFile(join(cwd, 'untracked file.txt'), 'new bytes'); await check('untracked');
  await unlink(join(cwd, 'tracked.txt')); await check('deleted');
  await writeFile(join(cwd, 'tracked.txt'), 'modified'); await chmod(join(cwd, 'tracked.txt'), 0o755); await check('executable');
  await symlink('tracked.txt', join(cwd, 'link')); await check('symlink');
  await unlink(join(cwd, 'link')); await symlink('untracked file.txt', join(cwd, 'link')); await check('retargeted-symlink');
  assert.notEqual(fingerprints.get('symlink'), fingerprints.get('retargeted-symlink'));
  await mkdir(join(cwd, 'nested'));
  const task = insertTask({ title: 'Nested baseline', status: 'in_progress', workdir: join(cwd, 'nested') });
  await captureCodingBaseline(task, 'identity');
  const evidence = await readCodingEvidence(task);
  assert.equal(evidence?.workdir, await realpath(cwd));
  assert.deepEqual(Object.keys(evidence!.baseline).sort(), ['fingerprint', 'head'], 'Baseline must not persist unused diagnostics');
  const captured = evidence!.baseline;
  await writeFile(join(cwd, 'tracked.txt'), 'later edit');
  await captureCodingBaseline(task, 'identity');
  assert.deepEqual((await readCodingEvidence(task))!.baseline, captured, 'Recapture cannot move the pre-agent baseline');
  const legacy = { ...evidence!, baseline: await baselineSnapshot(cwd) };
  db.prepare('UPDATE coding_evidence SET evidence_json=? WHERE task_id=?').run(JSON.stringify(legacy), task.id);
  assert.deepEqual((await readCodingEvidence(task))!.baseline, legacy.baseline, 'Old JSON with baseline diagnostics stays readable');
  const abort = new AbortController(); abort.abort(new Error('Stopped before identity'));
  await assert.rejects(sourceIdentity(cwd, abort.signal), /abort|Stopped/i);
  // The removed diagnostic Git calls used to observe an abort after the last
  // asynchronous symlink read. Identity-only capture must retain that boundary.
  await symlink('tracked.txt', join(cwd, 'zz-final-link'));
  const lastReadAbort = new AbortController(); const readlink = fsPromises.readlink;
  try {
    fsPromises.readlink = (async (...args: Parameters<typeof readlink>) => {
      const target = await readlink(...args);
      if (String(args[0]).endsWith('/zz-final-link')) lastReadAbort.abort(new Error('Stopped during final link read'));
      return target;
    }) as typeof readlink;
    syncBuiltinESMExports();
    await assert.rejects(sourceIdentity(cwd, lastReadAbort.signal), /Stopped during final link read/);
  } finally { fsPromises.readlink = readlink; syncBuiltinESMExports(); }
  await git('init', 'embedded');
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Nested'], { cwd: join(cwd, 'embedded') });
  await git('add', 'embedded');
  await assert.rejects(sourceIdentity(cwd), /Nested repositories/);
  await assert.rejects(baselineSnapshot(cwd), /Nested repositories/);
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Source identity oracle, baseline, legacy JSON and cancellation tests passed');
