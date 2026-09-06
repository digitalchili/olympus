import { stat, statfs, writeFile, unlink, mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { StorageMountInfo } from '../shared/types.js';

const execFilePromise = promisify(execFileCallback);

export function buildStorageMountInfo(
  device: string,
  mountPoint: string,
  fsType: string
): StorageMountInfo {
  // Check for remote network mounts
  if (
    fsType === 'fuse.sshfs' ||
    fsType === 'sshfs' ||
    device.includes('sshfs')
  ) {
    return {
      device,
      mountPoint,
      fsType,
      isExternal: true,
      label: `Remote SSHFS Drive (${mountPoint})`,
    };
  }

  if (fsType === 'nfs' || fsType === 'cifs' || fsType === 'smb3') {
    return {
      device,
      mountPoint,
      fsType,
      isExternal: true,
      label: `Network Storage (${fsType.toUpperCase()})`,
    };
  }

  // Check for secondary block devices (attached volumes, e.g. /dev/sdb, /dev/vdb, Hetzner volumes, AWS EBS)
  const isSecondaryDisk = /\/dev\/(sd[b-z]|vd[b-z]|xvd[b-z]|nvme[1-9])/i.test(device);
  const isPrimaryDisk = /\/dev\/(sda|vda|xvda|nvme0n1)/i.test(device);

  if (isSecondaryDisk) {
    return {
      device,
      mountPoint,
      fsType,
      isExternal: true,
      label: `Attached Volume (${device} · ${fsType})`,
    };
  }

  if (device.startsWith('/dev/disk/by-')) {
    const idName = device.split('/').pop() || device;
    return {
      device,
      mountPoint,
      fsType,
      isExternal: true,
      label: `Attached Volume (${idName} · ${fsType})`,
    };
  }

  if (isPrimaryDisk) {
    return {
      device,
      mountPoint,
      fsType,
      isExternal: false,
      label: `Primary VPS Disk (${device} · ${fsType})`,
    };
  }

  if (device === 'overlay' || fsType === 'overlay') {
    return {
      device,
      mountPoint,
      fsType,
      isExternal: false,
      label: `Container Overlay (${fsType})`,
    };
  }

  if (device === 'tmpfs' || fsType === 'tmpfs') {
    return {
      device,
      mountPoint,
      fsType,
      isExternal: false,
      label: 'Memory Drive (tmpfs)',
    };
  }

  const isDedicated = mountPoint !== '/' && !mountPoint.startsWith('/etc') && !mountPoint.startsWith('/sys') && !mountPoint.startsWith('/proc');
  return {
    device,
    mountPoint,
    fsType,
    isExternal: isDedicated,
    label: isDedicated ? `Dedicated Volume (${device} · ${fsType})` : `System Disk (${device} · ${fsType})`,
  };
}

export function parseLinuxMounts(mountsContent: string, targetPath: string): StorageMountInfo | null {
  const lines = mountsContent.split('\n');
  const resolvedTarget = resolve(targetPath);
  let bestMatch: { device: string; mountPoint: string; fsType: string } | null = null;
  let bestLen = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const rawDevice = parts[0];
    const rawMount = parts[1];
    const fsType = parts[2];

    const unescapedMount = rawMount.replace(/\\([0-7]{3})/g, (_, oct) =>
      String.fromCharCode(parseInt(oct, 8))
    );
    const resolvedMount = resolve(unescapedMount);

    // Skip pseudo filesystems that are not real storage
    if (
      fsType === 'proc' ||
      fsType === 'sysfs' ||
      fsType === 'devpts' ||
      fsType === 'cgroup' ||
      fsType === 'cgroup2' ||
      fsType === 'mqueue' ||
      fsType === 'autofs'
    ) {
      continue;
    }

    const isInside =
      resolvedTarget === resolvedMount ||
      (resolvedMount === '/' ? resolvedTarget.startsWith('/') : resolvedTarget.startsWith(resolvedMount + '/'));

    if (isInside && resolvedMount.length > bestLen) {
      bestLen = resolvedMount.length;
      bestMatch = {
        device: rawDevice.replace(/\\([0-7]{3})/g, (_, oct) =>
          String.fromCharCode(parseInt(oct, 8))
        ),
        mountPoint: resolvedMount,
        fsType,
      };
    }
  }

  if (!bestMatch) return null;
  return buildStorageMountInfo(bestMatch.device, bestMatch.mountPoint, bestMatch.fsType);
}

export async function detectStorageMount(
  targetPath: string,
  customMountsFile?: string
): Promise<StorageMountInfo | null> {
  const mountsPath = customMountsFile || '/proc/mounts';
  if (existsSync(mountsPath)) {
    try {
      const content = await readFile(mountsPath, 'utf8');
      return parseLinuxMounts(content, targetPath);
    } catch {
      // Ignore read errors and proceed to fallback
    }
  }

  // Fallback for macOS / BSD using `df -P`
  try {
    const { stdout } = await execFilePromise('df', ['-P', resolve(targetPath)], { timeout: 3000 });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const lastLine = lines[lines.length - 1].trim();
      const parts = lastLine.split(/\s+/);
      if (parts.length >= 6) {
        const device = parts[0];
        const mountPoint = parts.slice(5).join(' ');
        const isExternal = mountPoint.startsWith('/Volumes/') && !mountPoint.startsWith('/Volumes/Macintosh');
        const label = isExternal ? `External Drive (${device})` : `Local Disk (${device})`;
        return {
          device,
          mountPoint,
          fsType: process.platform === 'darwin' ? 'apfs' : 'unknown',
          isExternal,
          label,
        };
      }
    }
  } catch {
    // Non-fatal fallback
  }

  return null;
}

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
