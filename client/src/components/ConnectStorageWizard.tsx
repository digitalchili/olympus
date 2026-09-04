import { useState } from 'react';
import {
  X,
  HardDrive,
  Server,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ShieldCheck,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import type { StorageProbeResult } from '@shared/types';
import { probeLocalStorage, probeSshStorage } from '../lib/api';
import { toErrorMessage } from '../lib/format';

interface ConnectStorageWizardProps {
  isOpen: boolean;
  onClose: () => void;
  isDocker: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function ConnectStorageWizard({ isOpen, onClose, isDocker }: ConnectStorageWizardProps) {
  const [storageType, setStorageType] = useState<'attached' | 'ssh'>('attached');

  // Local attached form
  const [localPath, setLocalPath] = useState('/mnt/storage');

  // SSH form
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('root');
  const [sshRemotePath, setSshRemotePath] = useState('/mnt/olympus-data');
  const [sshKey, setSshKey] = useState('');

  // Probe state
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<StorageProbeResult | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleTest = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      if (storageType === 'attached') {
        const res = await probeLocalStorage(localPath);
        setProbeResult(res);
      } else {
        const res = await probeSshStorage({
          host: sshHost,
          port: Number(sshPort) || 22,
          username: sshUser,
          remotePath: sshRemotePath,
          privateKey: sshKey ? sshKey : undefined,
        });
        setProbeResult(res);
      }
    } catch (err) {
      setProbeResult({
        ok: false,
        error: toErrorMessage(err),
      });
    } finally {
      setProbing(false);
    }
  };

  const copySnippet = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeMountPath = storageType === 'attached' ? localPath : '/mnt/remote-storage';

  const dockerOverrideYaml = `services:
  olympus-dispatch:
    volumes:
      - ${activeMountPath}/olympus-dispatch:/opt/data/olympus-dispatch
      - ${activeMountPath}/hermes:/opt/data`;

  const sshMountCommand = `sudo apt-get install -y sshfs
sudo mkdir -p /mnt/remote-storage
sudo sshfs ${sshUser || 'user'}@${sshHost || 'remote-host'}:${sshRemotePath} /mnt/remote-storage \\
  -o allow_other,default_permissions,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
              <HardDrive size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Connect Storage Drive
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Pre-flight validation for external block volumes or remote SSH drives
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {/* Step 1: Storage Type */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 block mb-2">
              1. Select Storage Type
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setStorageType('attached'); setProbeResult(null); }}
                className={`p-3.5 rounded-lg border text-left flex items-start gap-3 transition-all ${
                  storageType === 'attached'
                    ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
                }`}
              >
                <HardDrive size={18} className="mt-0.5 text-zinc-700 dark:text-zinc-300" />
                <div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Attached Block Disk
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Secondary SSD, Hetzner Cloud Volume, or AWS EBS
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => { setStorageType('ssh'); setProbeResult(null); }}
                className={`p-3.5 rounded-lg border text-left flex items-start gap-3 transition-all ${
                  storageType === 'ssh'
                    ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
                }`}
              >
                <Server size={18} className="mt-0.5 text-zinc-700 dark:text-zinc-300" />
                <div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Remote Drive via SSH
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Another server, VPS, or NAS mounted over SSHFS
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Step 2: Form Fields */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 block mb-2">
              2. Connection & Path Details
            </label>

            {storageType === 'attached' ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    Host Directory Path
                  </label>
                  <input
                    type="text"
                    value={localPath}
                    onChange={(e) => { setLocalPath(e.target.value); setProbeResult(null); }}
                    placeholder="/mnt/storage or /mnt/HC_Volume_106792525"
                    className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                  />
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 block">
                    Must be an accessible directory formatted on the host machine.
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                      Remote Host / IP
                    </label>
                    <input
                      type="text"
                      value={sshHost}
                      onChange={(e) => { setSshHost(e.target.value); setProbeResult(null); }}
                      placeholder="192.168.1.50 or storage.example.com"
                      className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                      SSH Port
                    </label>
                    <input
                      type="number"
                      value={sshPort}
                      onChange={(e) => { setSshPort(Number(e.target.value)); setProbeResult(null); }}
                      placeholder="22"
                      className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                      SSH Username
                    </label>
                    <input
                      type="text"
                      value={sshUser}
                      onChange={(e) => { setSshUser(e.target.value); setProbeResult(null); }}
                      placeholder="root or ubuntu"
                      className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                      Remote Storage Path
                    </label>
                    <input
                      type="text"
                      value={sshRemotePath}
                      onChange={(e) => { setSshRemotePath(e.target.value); setProbeResult(null); }}
                      placeholder="/mnt/olympus-data"
                      className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    SSH Private Key (PEM / OpenSSH format)
                  </label>
                  <textarea
                    rows={3}
                    value={sshKey}
                    onChange={(e) => { setSshKey(e.target.value); setProbeResult(null); }}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                    className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 resize-none"
                  />
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 block">
                    Optional if your host machine already has SSH key authorization configured for this user.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Step 3: Test Button */}
          <div className="pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={probing}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 text-xs font-medium transition-colors disabled:opacity-50 shadow-sm"
            >
              {probing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Testing connection, permissions & space...
                </>
              ) : (
                <>
                  <RefreshCw size={14} />
                  Test Connection & Permissions
                </>
              )}
            </button>
          </div>

          {/* Test Results Display */}
          {probeResult && (
            <div className="space-y-4 pt-1">
              {probeResult.ok ? (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/80 bg-emerald-50 dark:bg-emerald-950/40 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-semibold text-xs">
                    <CheckCircle2 size={16} />
                    <span>Connection & Permissions Verified Successfully!</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px] text-emerald-700 dark:text-emerald-300/90 font-mono">
                    <div>✔ Read/Write Access: Verified</div>
                    {probeResult.availableBytes ? (
                      <div>✔ Free Space: {formatBytes(probeResult.availableBytes)} available</div>
                    ) : (
                      <div>✔ Capacity: Verified</div>
                    )}
                  </div>

                  {/* Implementation instructions */}
                  <div className="mt-3 pt-3 border-t border-emerald-200/80 dark:border-emerald-900/60 space-y-2">
                    <div className="flex items-center justify-between text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      <span>Ready to activate! Copy configuration:</span>
                      <button
                        onClick={() => copySnippet(storageType === 'attached' ? dockerOverrideYaml : sshMountCommand)}
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 font-normal"
                      >
                        {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>

                    <pre className="p-2.5 rounded bg-zinc-900 text-zinc-100 font-mono text-[11px] overflow-x-auto select-all">
                      {storageType === 'attached' ? dockerOverrideYaml : sshMountCommand}
                    </pre>

                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <ShieldCheck size={13} className="text-emerald-500" />
                      <span>Your current live storage remains untouched until you restart with this mount.</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-rose-200 dark:border-rose-900/80 bg-rose-50 dark:bg-rose-950/40 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-rose-800 dark:text-rose-300 font-semibold text-xs">
                    <AlertCircle size={16} />
                    <span>Connection Pre-flight Failed</span>
                  </div>
                  <p className="text-xs text-rose-700 dark:text-rose-300/90">
                    {probeResult.error || 'Could not verify storage destination.'}
                  </p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 pt-1">
                    No changes were made to your system. Please verify the path, host reachability, or credentials and retry.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 bg-zinc-50 dark:bg-zinc-900/80 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400">
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-emerald-500" />
            <span>Non-destructive validation</span>
          </div>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
