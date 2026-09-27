// Frozen sourceSnapshot algorithm from 9ba0fd6. Keep independent of production extraction.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { SourceSnapshot } from '../../shared/coding-evidence.js';
const exec = promisify(execFile);
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await exec('git', args, { cwd, signal, maxBuffer: 8 * 1024 * 1024 })).stdout;
}
function redact(text: string): string {
  return text.replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
export async function baselineSnapshot(cwd: string, startingHead?: string, signal?: AbortSignal): Promise<SourceSnapshot> {
  const head = (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim();
  const files = [...new Set((await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256').update(head);
  for (const file of files) {
    signal?.throwIfAborted();
    hash.update('\0' + file + '\0');
    try {
      const info = await lstat(join(cwd, file));
      hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(await readlink(join(cwd, file)));
      else if (info.isFile()) for await (const chunk of createReadStream(join(cwd, file), { signal })) hash.update(chunk);
      else throw new Error('Nested repositories need explicit verification in their own task');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted');
      else throw error;
    }
  }
  const comparedHead = startingHead ?? head;
  const untracked = (await git(cwd, ['status', '--porcelain', '--untracked-files=all'], signal)).split('\n').filter(line => line.startsWith('?? '));
  const changedFiles = [...(await git(cwd, ['diff', '--name-status', comparedHead, '--'], signal)).trim().split('\n').filter(Boolean), ...untracked];
  const diff = redact(await git(cwd, ['diff', comparedHead, '--'], signal)).slice(0, 256_000);
  return { head, fingerprint: hash.digest('hex'), changedFiles, diff };
}
