import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'verification-progress-'));
process.env.DB_PATH = join(root, 'db');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { captureCodingBaseline, verifyCodingRun, readCodingEvidence } = await import('../server/coding-verification.js');
const cwd = join(root, 'repo');
const release = join(root, 'release');
let pending: Promise<boolean> | undefined;
try {
  await mkdir(join(cwd, '.olympus'), { recursive: true });
  const command = [process.execPath, '-e', `console.log('First test started'); console.log('Bearer fixture-credential'); setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})) process.exit(0)},20)`];
  await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [command] }));
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd });
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await git('add', '.'); await git('commit', '-m', 'Checks');
  const task = insertTask({ title: 'Progress', status: 'in_progress', workdir: cwd });
  await captureCodingBaseline(task, 'progress');
  pending = verifyCodingRun(task, 'progress', 5000);
  let evidence;
  for (let i = 0; i < 100; i++) {
    evidence = await readCodingEvidence(task);
    if (evidence?.currentCheck?.output.includes('First test started')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(evidence?.status, 'running');
  assert.deepEqual(evidence?.currentCheck?.command, command, 'the active command must be visible before it exits');
  assert.match(evidence?.currentCheck?.output ?? '', /First test started/);
  assert.doesNotMatch(evidence?.currentCheck?.output ?? '', /fixture-credential/, 'live output is redacted too');
  assert.deepEqual(evidence?.checks, [], 'a still-running check is not labeled failed or passed');
  const initialDuration = evidence!.currentCheck!.durationMs;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok((await readCodingEvidence(task))!.currentCheck!.durationMs > initialDuration, 'quiet commands still publish elapsed progress');
  await writeFile(release, 'finish');
  assert.equal(await pending, true);
  const finished = await readCodingEvidence(task);
  assert.equal(finished?.currentCheck, null);
  assert.equal(finished?.checks[0].exitCode, 0);
  assert.match(finished?.checks[0].output ?? '', /First test started/);
  console.log('Verification live command progress tests passed');
} finally {
  await writeFile(release, 'finish');
  await pending;
  db.close(); await rm(root, { recursive: true, force: true });
}
