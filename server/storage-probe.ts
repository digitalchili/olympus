import { stat, statfs, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFileCallback);

export interface StorageProbeResult {
  ok: boolean;
  error?: string;
  totalBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
  usedPercent?: number;
  isWritable?: boolean;
}

export interface SshProbeInput {
  host: string;
  port?: number;
  username: string;
  authType?: 'key' | 'password';
  privateKey?: string;
  remotePath: string;
}

export async function testLocalPathProbe(targetPath: string): Promise<StorageProbeResult> {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return { ok: false, error: 'Target path is required.' };
  }
  const resolved = resolve(targetPath.trim());
  try {
    const s = await stat(resolved);
    if (!s.isDirectory()) {
      return { ok: false, error: `Path "${resolved}" is a file, not a directory.` };
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      return { ok: false, error: `Directory "${resolved}" does not exist.` };
    }
    return { ok: false, error: `Cannot access path "${resolved}": ${(err as Error).message}` };
  }

  // Test write permissions by creating and removing a probe file
  const probeFile = join(resolved, `.olympus_probe_${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(probeFile, 'olympus-write-test', { flag: 'wx' });
    await unlink(probeFile);
  } catch {
    return { ok: false, error: `Directory "${resolved}" is not writable (permission denied).` };
  }

  // Read filesystem disk capacity
  try {
    const stats = await statfs(resolved);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    return {
      ok: true,
      totalBytes,
      availableBytes,
      usedBytes,
      usedPercent,
      isWritable: true,
    };
  } catch {
    return {
      ok: true,
      isWritable: true,
    };
  }
}

export async function testSshStorageProbe(input: SshProbeInput): Promise<StorageProbeResult> {
  const host = input.host?.trim();
  const username = input.username?.trim();
  const port = input.port && input.port > 0 ? input.port : 22;
  const remotePath = input.remotePath?.trim();

  if (!host) return { ok: false, error: 'Remote host or IP address is required.' };
  if (!username) return { ok: false, error: 'SSH username is required.' };
  if (!remotePath) return { ok: false, error: 'Remote storage path is required.' };

  let tempKeyFile: string | null = null;
  let tempDir: string | null = null;

  try {
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(port),
    ];

    if (input.privateKey && input.privateKey.trim()) {
      tempDir = await mkdtemp(join(tmpdir(), 'olympus-ssh-probe-'));
      tempKeyFile = join(tempDir, 'id_rsa');
      const keyContent = input.privateKey.trim().endsWith('\n')
        ? input.privateKey.trim()
        : `${input.privateKey.trim()}\n`;
      await writeFile(tempKeyFile, keyContent, { mode: 0o600 });
      sshArgs.push('-i', tempKeyFile);
    }

    sshArgs.push(`${username}@${host}`);

    const probeFileName = `.olympus_probe_${randomUUID().slice(0, 8)}`;
    const remoteCmd = `mkdir -p "${remotePath}" && touch "${remotePath}/${probeFileName}" && rm -f "${remotePath}/${probeFileName}" && df -k "${remotePath}"`;
    sshArgs.push(remoteCmd);

    const { stdout } = await execFilePromise('ssh', sshArgs, { timeout: 12000 });

    const lines = stdout.trim().split('\n');
    let totalBytes: number | undefined;
    let availableBytes: number | undefined;
    let usedBytes: number | undefined;
    let usedPercent: number | undefined;

    if (lines.length >= 2) {
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      if (parts.length >= 4) {
        const totalKb = parseInt(parts[1], 10);
        const usedKb = parseInt(parts[2], 10);
        const availKb = parseInt(parts[3], 10);
        if (!isNaN(totalKb) && !isNaN(availKb)) {
          totalBytes = totalKb * 1024;
          availableBytes = availKb * 1024;
          usedBytes = (usedKb || 0) * 1024;
          usedPercent = totalBytes > 0 ? Math.round(((totalBytes - availableBytes) / totalBytes) * 100) : 0;
        }
      }
    }

    return {
      ok: true,
      isWritable: true,
      totalBytes,
      availableBytes,
      usedBytes,
      usedPercent,
    };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr;
    const msg = stderr ? String(stderr).trim() : (err as Error).message;
    if (/permission denied/i.test(msg)) {
      return { ok: false, error: 'SSH Authentication failed (invalid credentials or unauthorized user).' };
    }
    if (/connection timed out|timed out/i.test(msg)) {
      return { ok: false, error: `Connection timed out reaching ${host}:${port}. Verify the host is online and port is reachable.` };
    }
    if (/no route to host|could not resolve hostname/i.test(msg)) {
      return { ok: false, error: `Could not resolve or connect to host "${host}".` };
    }
    return { ok: false, error: msg || 'SSH connection probe failed.' };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
