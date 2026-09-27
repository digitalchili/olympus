import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = await mkdtemp(join(tmpdir(), 'coding-evidence-'));
process.env.DB_PATH = join(root, 'db.sqlite'); process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { captureCodingBaseline, verifyCodingRun, readCodingEvidence, codingReviewAllowed } = await import('../server/coding-verification.js');
const cwd = join(root, 'repo'); await mkdir(join(cwd, '.olympus'), { recursive: true });
const git = (...args: string[]) => promisify(execFile)('git', args, { cwd });
try {
 await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
 await writeFile(join(cwd, 'source.txt'), 'before'); await git('add', '.'); await git('commit', '-m', 'baseline');
 const task = insertTask({ title: 'Coding task', status: 'in_progress', workdir: cwd });
 await captureCodingBaseline(task, 'run');
 await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'console.log("checked")']] }));
 await writeFile(join(cwd, 'source.txt'), 'after');
 assert.equal(await verifyCodingRun(task, 'run'), true);
 let evidence = await readCodingEvidence(task);
 assert.equal(evidence?.status, 'passed'); assert.equal(evidence?.checks[0]?.exitCode, 0); assert.match(evidence?.checks[0]?.output ?? '', /checked/);
 // Hold an older scan before hashing, then change same-length bytes and restore
 // mtime. A later freshness request must scan independently, not reuse that read.
 const bin = join(root, 'git-bin'); await mkdir(bin);
 const entered = join(root, 'scan-entered'); const released = join(root, 'scan-released');
 const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
 const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
 const waitScript = `require('fs').writeFileSync(${JSON.stringify(entered)},'ready');const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(released)})){clearInterval(timer)}},5);`;
 await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = ls-files ] && mkdir ${quote(join(root, 'first-scan'))} 2>/dev/null; then\n${quote(process.execPath)} -e ${quote(waitScript)}\nfi\nexec ${quote(realGit)} "$@"\n`);
 await chmod(join(bin, 'git'), 0o755);
 const originalPath = process.env.PATH; let older: ReturnType<typeof readCodingEvidence> | undefined;
 try {
  process.env.PATH = `${bin}:${originalPath}`;
  older = readCodingEvidence(task);
  for (let i = 0; i < 500 && !existsSync(entered); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(entered), true, 'Older scan reached its deterministic latch');
  const metadata = await stat(join(cwd, 'source.txt'));
  await writeFile(join(cwd, 'source.txt'), 'other');
  await utimes(join(cwd, 'source.txt'), metadata.atime, metadata.mtime);
  evidence = await readCodingEvidence(task);
  assert.equal(evidence?.status, 'stale', 'A newer scan independently detects same-HEAD/length/mtime edits');
 } finally {
  await writeFile(released, 'continue'); await older; process.env.PATH = originalPath;
 }
 assert.equal(codingReviewAllowed(task.id, 'run'), false, 'a detected stale result must not remain passed in the review gate');
 await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(1)']] }));
 assert.equal(await verifyCodingRun(task, 'run'), false);
 assert.equal((await readCodingEvidence(task))?.status, 'failed');
 await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'setTimeout(()=>console.log("Finished naturally"),200)']] }));
 assert.equal(await verifyCodingRun(task, 'run'), true, 'verification must finish naturally, without a wrapper time cap');
 await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'require("fs").writeFileSync("source.txt","mutated during check")']] }));
 assert.equal(await verifyCodingRun(task, 'run'), false, 'checks that modify source cannot attest the original source');
 await mkdir(join(cwd, 'client'));
 const nested = insertTask({ title: 'Nested coding task', status: 'in_progress', workdir: join(cwd, 'client') });
 await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(1)']] }));
 await captureCodingBaseline(nested, 'nested');
 assert.equal(await verifyCodingRun(nested, 'nested'), false, 'nested workdirs must use repository verification');
 await git('add', '.'); await git('commit', '-m', 'committed failing source');
 assert.equal(await verifyCodingRun(task, 'run'), false);
 assert.match((await readCodingEvidence(task))?.source?.diff ?? '', /mutated during check/, 'committed changes remain in the run diff');
 await captureCodingBaseline(task, 'noop');
 assert.equal(await verifyCodingRun(task, 'noop'), false, 'a no-op turn must not bypass failed checks on committed source');
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Coding verification tests passed');
