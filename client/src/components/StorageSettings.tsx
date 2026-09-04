import { useCallback, useEffect, useState } from 'react';
import {
  HardDrive,
  FolderTree,
  Server,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  Terminal,
  Plus,
} from 'lucide-react';
import type { StorageStatus } from '@shared/types';
import { fetchStorageStatus } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { ConnectStorageWizard } from './ConnectStorageWizard';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function StorageSettings() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchStorageStatus();
      setStatus(data);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const copyToClipboard = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const disk = status?.disk;
  const usedPercent = disk?.usedPercent ?? 0;
  const isCritical = usedPercent >= 95;
  const isWarning = usedPercent >= 85 && !isCritical;

  const barColor = isCritical
    ? 'bg-rose-500 dark:bg-rose-600'
    : isWarning
      ? 'bg-amber-500 dark:bg-amber-600'
      : 'bg-emerald-500 dark:bg-emerald-600';

  const statusBadge = isCritical ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 px-2 py-0.5 rounded-full border border-rose-200 dark:border-rose-900">
      <AlertTriangle size={12} /> Critical Space
    </span>
  ) : isWarning ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-900">
      <AlertTriangle size={12} /> Low Space
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-900">
      <CheckCircle2 size={12} /> Healthy
    </span>
  );

  return (
    <div className="space-y-6">
      {/* Disk Usage Card */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200">
              <HardDrive size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Disk Storage</h3>
                {disk && statusBadge}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Volume storage for task workspaces, SQLite state, and project repositories.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setWizardOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 transition-colors shadow-sm"
            >
              <Plus size={13} />
              Connect Storage Drive
            </button>
            <button
              onClick={() => void loadStatus()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 p-3 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {disk ? (
          <div className="space-y-3 mt-4">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)} ({usedPercent}%)
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {formatBytes(disk.freeBytes)} free
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${barColor}`}
                style={{ width: `${Math.min(100, Math.max(2, usedPercent))}%` }}
              />
            </div>
          </div>
        ) : !loading && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
            Disk metric information is not available in this container environment.
          </p>
        )}
      </section>

      {/* Active Paths Card */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 mb-3">
          <FolderTree size={18} className="text-zinc-500 dark:text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Storage Locations</h3>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80 text-xs">
          <div className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
            <span className="text-zinc-500 dark:text-zinc-400 font-medium sm:w-48">Olympus State & DB</span>
            <span className="font-mono text-zinc-800 dark:text-zinc-200 truncate select-all">{status?.olympusHome ?? '—'}</span>
          </div>
          <div className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
            <span className="text-zinc-500 dark:text-zinc-400 font-medium sm:w-48">Hermes & Workspaces</span>
            <span className="font-mono text-zinc-800 dark:text-zinc-200 truncate select-all">{status?.hermesHome ?? '—'}</span>
          </div>
          <div className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
            <span className="text-zinc-500 dark:text-zinc-400 font-medium sm:w-48">Project Checkouts</span>
            <span className="font-mono text-zinc-800 dark:text-zinc-200 truncate select-all">{status?.projectRoot ?? '—'}</span>
          </div>
          <div className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
            <span className="text-zinc-500 dark:text-zinc-400 font-medium sm:w-48">Runtime Mode</span>
            <span className="inline-flex items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-300">
              <Server size={13} className="text-zinc-400" />
              {status?.isDocker ? 'Docker Container' : 'Local Host / Bare-Metal'}
            </span>
          </div>
        </div>
      </section>

      {/* Configuration & Storage Setup Guides */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Terminal size={18} className="text-zinc-500 dark:text-zinc-400" />
            Storage Customization Options
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            By default, Olympus stores all repositories and state locally on the VPS disk. If you need larger or external storage:
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Guide 1: Attached Volume */}
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/50 dark:bg-zinc-950/30 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                Option A: Attached Block Disk
              </span>
              <button
                onClick={() => copyToClipboard('attached', `services:\n  olympus-dispatch:\n    volumes:\n      - /mnt/storage/olympus-dispatch:/opt/data/olympus-dispatch\n      - /mnt/storage/hermes:/opt/data`)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                title="Copy YAML"
              >
                {copiedKey === 'attached' ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Attach a Hetzner Volume, AWS EBS, or secondary SSD at <code className="text-zinc-800 dark:text-zinc-200">/mnt/storage</code> and add a <code className="text-zinc-800 dark:text-zinc-200">docker-compose.override.yml</code>:
            </p>
            <pre className="p-2 rounded bg-zinc-900 text-zinc-100 font-mono text-[11px] overflow-x-auto select-all">
{`services:
  olympus-dispatch:
    volumes:
      - /mnt/storage/olympus-dispatch:/opt/data/olympus-dispatch
      - /mnt/storage/hermes:/opt/data`}
            </pre>
          </div>

          {/* Guide 2: Remote Storage via SSH */}
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/50 dark:bg-zinc-950/30 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                Option B: Remote Drive over SSH (SSHFS)
              </span>
              <button
                onClick={() => copyToClipboard('sshfs', `sudo apt-get install -y sshfs\nsudo mkdir -p /mnt/remote-storage\nsudo sshfs user@remote-host:/path/to/storage /mnt/remote-storage -o allow_other,default_permissions,reconnect`)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                title="Copy command"
              >
                {copiedKey === 'sshfs' ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Mounting at the host OS level ensures SQLite WAL atomic file locking. Mount your remote SSH drive with <code className="text-zinc-800 dark:text-zinc-200">sshfs</code>:
            </p>
            <pre className="p-2 rounded bg-zinc-900 text-zinc-100 font-mono text-[11px] overflow-x-auto select-all">
{`sudo apt-get install -y sshfs
sudo mkdir -p /mnt/remote-storage
sudo sshfs user@remote-host:/path/to/storage /mnt/remote-storage \\
  -o allow_other,default_permissions,reconnect`}
            </pre>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2 text-xs text-zinc-500 dark:text-zinc-400">
          <ShieldCheck size={14} className="text-emerald-500" />
          <span>Existing production storage settings are fully preserved and isolated from container rebuilds.</span>
        </div>
      </section>

      <ConnectStorageWizard
        isOpen={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          void loadStatus();
        }}
        isDocker={Boolean(status?.isDocker)}
      />
    </div>
  );
}
