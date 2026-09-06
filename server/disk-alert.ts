import { statfs } from 'node:fs/promises';
import { resolveOlympusHome } from './paths.js';
import { detectStorageMount } from './storage-probe.js';
import { insertTask, updateTask } from './db/queries.js';
import { broadcast } from './events.js';
import db from './db/index.js';
import { DEFAULT_PROFILE_NAME, type Task } from '../shared/types.js';
import { errorCode } from './errors.js';
import { operationalLog } from './observability.js';

export const DISK_ALERT_THRESHOLD_PERCENT = 90;
export const DISK_RECOVERY_THRESHOLD_PERCENT = 85;
export const DISK_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours cooldown after dismissal
const RECOVERED_ALERT_KEY = 'disk_alert_recovered_task';
let checkQueue: Promise<unknown> = Promise.resolve();

export interface DiskAlertCheckOptions {
  customStats?: {
    totalBytes: number;
    freeBytes: number;
  };
  customHome?: string;
  thresholdPercent?: number;
  recoveryPercent?: number;
  canWrite?: () => boolean;
}

export interface DiskAlertResult {
  alerted: boolean;
  resolved: boolean;
  usedPercent: number;
  totalBytes: number;
  freeBytes: number;
  task?: Task;
}

export function getActiveDiskAlertTask(): Task | null {
  const stmt = db.prepare<[string, string], Task>(
    "SELECT * FROM tasks WHERE routing_source = ? AND status != ? ORDER BY created_at DESC LIMIT 1"
  );
  return stmt.get('system_alert', 'done') ?? null;
}

export function getRecentDiskAlertTask(sinceMs: number): Task | null {
  const stmt = db.prepare<[string, number], Task>(
    "SELECT * FROM tasks WHERE routing_source = ? AND updated_at > ? ORDER BY updated_at DESC, rowid DESC LIMIT 1"
  );
  return stmt.get('system_alert', sinceMs) ?? null;
}

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Preserve observation order when timer and Settings requests overlap. */
export function checkDiskSpaceAndAlert(options?: DiskAlertCheckOptions): Promise<DiskAlertResult> {
  const check = checkQueue.then(() => runDiskSpaceCheck(options));
  checkQueue = check.catch(() => undefined);
  return check;
}

/** Background callers must settle even when the monitored disk cannot accept writes. */
export async function pollDiskSpaceAndAlert(options?: DiskAlertCheckOptions): Promise<DiskAlertResult | null> {
  try {
    return await checkDiskSpaceAndAlert(options);
  } catch (error) {
    operationalLog('disk_alert_failed', { code: errorCode(error) ?? 'DISK_ALERT_FAILED' });
    return null;
  }
}

async function runDiskSpaceCheck(
  options?: DiskAlertCheckOptions
): Promise<DiskAlertResult> {
  const threshold = options?.thresholdPercent ?? DISK_ALERT_THRESHOLD_PERCENT;
  const recovery = options?.recoveryPercent ?? DISK_RECOVERY_THRESHOLD_PERCENT;
  const olympusHome = options?.customHome ?? resolveOlympusHome();

  let totalBytes = 0;
  let freeBytes = 0;

  if (options?.customStats) {
    totalBytes = options.customStats.totalBytes;
    freeBytes = options.customStats.freeBytes;
  } else {
    try {
      const stats = await statfs(olympusHome);
      totalBytes = Number(stats.blocks) * Number(stats.bsize);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return { alerted: false, resolved: false, usedPercent: 0, totalBytes: 0, freeBytes: 0 };
    }
  }

  if (totalBytes <= 0) {
    return { alerted: false, resolved: false, usedPercent: 0, totalBytes: 0, freeBytes: 0 };
  }

  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = Math.round((usedBytes / totalBytes) * 100);
  const skipped = { alerted: false, resolved: false, usedPercent, totalBytes, freeBytes };
  // Read-only requests and queued timer polls must stop writing as soon as
  // maintenance begins, including if they were admitted before the drain.
  if (options?.canWrite?.() === false) return skipped;

  // 1. High Disk Usage Alert Condition (>= 90%)
  if (usedPercent >= threshold) {
    const activeAlert = getActiveDiskAlertTask();
    if (activeAlert) {
      return {
        alerted: true,
        resolved: false,
        usedPercent,
        totalBytes,
        freeBytes,
        task: activeAlert,
      };
    }

    // A user dismissal pauses the current incident; an observed recovery ends it.
    const recentAlert = getRecentDiskAlertTask(Date.now() - DISK_ALERT_COOLDOWN_MS);
    const recoveredAlert = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(RECOVERED_ALERT_KEY) as { value: string } | undefined;
    if (recentAlert && recentAlert.id !== recoveredAlert?.value) {
      return {
        alerted: true,
        resolved: false,
        usedPercent,
        totalBytes,
        freeBytes,
        task: recentAlert,
      };
    }

    const mount = await detectStorageMount(olympusHome);
    if (options?.canWrite?.() === false) return skipped;
    const deviceName = mount?.device || 'Attached Storage';

    const title = `⚠️ Storage Alert: High Disk Usage on ${deviceName} (${usedPercent}%)`;
    const description = `Active storage has reached ${usedPercent}% capacity (${formatGb(usedBytes)} GB used of ${formatGb(totalBytes)} GB, ${formatGb(freeBytes)} GB remaining). Please clean up unused caches, task artifacts, or expand the volume size.`;

    const newTask = insertTask({
      title,
      description,
      status: 'in_review',
      routing_source: 'system_alert',
      profile_name: null,
      handling_profile_id: DEFAULT_PROFILE_NAME,
      last_agent_response_at: Date.now(),
    });

    broadcast({ type: 'task_created', task: newTask });

    return {
      alerted: true,
      resolved: false,
      usedPercent,
      totalBytes,
      freeBytes,
      task: newTask,
    };
  }

  // 2. Recovery Condition (< 85%)
  if (usedPercent < recovery) {
    const activeAlert = getActiveDiskAlertTask();
    const recoveredAlert = activeAlert ?? getRecentDiskAlertTask(Date.now() - DISK_ALERT_COOLDOWN_MS);
    if (recoveredAlert) {
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE value != excluded.value
      `).run(RECOVERED_ALERT_KEY, recoveredAlert.id, Date.now());
    }
    if (activeAlert && (activeAlert.status === 'in_review' || activeAlert.status === 'in_progress')) {
      const resolutionNote = `Storage space recovered to ${usedPercent}% (${formatGb(freeBytes)} GB free of ${formatGb(totalBytes)} GB). Alert resolved automatically.`;
      const updated = updateTask(activeAlert.id, {
        status: 'done',
        description: activeAlert.description ? `${activeAlert.description}\n\n✔ ${resolutionNote}` : resolutionNote,
      });

      if (updated) {
        broadcast({ type: 'task_updated', task: updated });
        return {
          alerted: false,
          resolved: true,
          usedPercent,
          totalBytes,
          freeBytes,
          task: updated,
        };
      }
    }
  }

  return { alerted: false, resolved: false, usedPercent, totalBytes, freeBytes };
}
