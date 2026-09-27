// Run before extraction, then with --after; every repository and DB is disposable.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineSnapshot } from './source-identity-oracle.js';
const root = await mkdtemp(join(tmpdir(), 'olympus-source-benchmark-'));
process.env.DB_PATH = join(root, 'db');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const { default: db } = await import('../../server/db/index.js');
const production = await import('../../server/coding-verification.js');
const exec = promisify(execFile);
const realGit = (await exec('which', ['git'])).stdout.trim();
const bin = join(root, 'bin'); const calls = join(root, 'calls');
const oldPath = process.env.PATH;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await mkdir(bin);
await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf 'git\\n' >> ${quote(calls)}\nexec ${quote(realGit)} "$@"\n`);
await chmod(join(bin, 'git'), 0o755);
const after = process.argv.includes('--after');
const current = after ? (production as any).sourceIdentity : production.sourceSnapshot;
assert.equal(typeof current, 'function');
try {
  for (const [name, files, bytes] of [['small', 20, 1024], ['large', 1000, 8192]] as const) {
    const cwd = join(root, name); await mkdir(cwd);
    const git = (...args: string[]) => exec(realGit, args, { cwd });
    await git('init', '-q'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    for (let i = 0; i < files; i++) await writeFile(join(cwd, `file-${i}.txt`), 'a'.repeat(bytes));
    await git('add', '.'); await git('commit', '-qm', 'Fixture');
    for (let i = 0; i < files / 2; i++) await writeFile(join(cwd, `file-${i}.txt`), 'b'.repeat(bytes));
    const oracle = await baselineSnapshot(cwd);
    process.env.PATH = `${bin}:${oldPath}`;
    const samples: Array<{ variant: string; wallMs: number; gitProcesses: number; payloadBytes: number }> = [];
    // Alternate old/current with two warmups and 30 measured runs each after extraction.
    for (let i = -2; i < 30; i++) for (const [variant, snapshot] of after ? [['before', baselineSnapshot], ['after', current]] as const : [['before', current]] as const) {
      await writeFile(calls, '');
      const start = performance.now(); const result = await snapshot(cwd); const wallMs = performance.now() - start;
      assert.equal(result.fingerprint, oracle.fingerprint, 'Benchmark must preserve source identity');
      const gitProcesses = (await readFile(calls, 'utf8')).trim().split('\n').length;
      assert.equal(gitProcesses, variant === 'after' ? 2 : 5, 'Identity-only callers avoid three diagnostic Git processes');
      if (i >= 0) samples.push({ variant, wallMs, gitProcesses, payloadBytes: Buffer.byteLength(JSON.stringify(result)) });
    }
    process.env.PATH = oldPath;
    for (const variant of after ? ['before', 'after'] : ['before']) {
      const rows = samples.filter(row => row.variant === variant); const times = rows.map(row => row.wallMs).sort((a, b) => a - b);
      console.log(JSON.stringify({ name, variant, files, bytes: files * bytes, samples: rows.length, medianMs: (times[14] + times[15]) / 2, p95Ms: times[28], gitProcesses: rows[0].gitProcesses, payloadBytes: rows[0].payloadBytes, rawMs: rows.map(row => Number(row.wallMs.toFixed(3))) }));
    }
  }
} finally { process.env.PATH = oldPath; db.close(); await rm(root, { recursive: true, force: true }); }
