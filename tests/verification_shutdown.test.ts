import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'verification-shutdown-'));
const repo = join(root, 'repo');
const run = promisify(execFile);
const git = (...args: string[]) => run('git', args, { cwd: repo });
try {
  await mkdir(join(repo, '.olympus'), { recursive: true });
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'source'), 'before'); await git('add', '.'); await git('commit', '-m', 'Initial');
  const ready = join(root, 'ready'); const finished = join(root, 'finished');
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(finished)},'finished'),800)`;
  await writeFile(join(repo, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e',
    `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'})`,
  ]] }));
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
  const parent = join(root, 'parent.mts');
  await writeFile(parent, `
    process.env.DB_PATH=${JSON.stringify(join(root, 'db'))};process.env.OLYMPUS_DISPATCH_HOME=${JSON.stringify(root)};
    process.env.HERMES_HOME=${JSON.stringify(join(root, 'hermes'))};
    const {insertTask}=await import(${moduleUrl('server/db/queries.ts')});
    const verification=await import(${moduleUrl('server/coding-verification.ts')});
    const {trackTaskRun,getActiveTaskRunCount}=await import(${moduleUrl('server/task-run-lifecycle.ts')});
    const {DrainController}=await import(${moduleUrl('server/drain.ts')});
    const {existsSync}=await import('node:fs');
    const task=insertTask({title:'Drain',status:'in_progress',workdir:${JSON.stringify(repo)}});
    await verification.captureCodingBaseline(task,'run');
    void trackTaskRun(task.id,verification.verifyCodingRun(task,'run').then(()=>{}));
    while(!existsSync(${JSON.stringify(ready)}))await new Promise(resolve=>setTimeout(resolve,10));
    const drain=new DrainController(getActiveTaskRunCount);drain.begin();await drain.waitForIdle(20);
    await verification.cancelAllCodingVerifications?.();
    if (verification.cancelAllCodingVerifications && await verification.verifyCodingRun(task,'late-run')) throw new Error('Shutdown allowed a late verification');
    process.exit(0);
  `);
  await run(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, parent]);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(existsSync(finished), false, 'shutdown must reap detached verification commands before the server exits');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Verification shutdown tests passed');
