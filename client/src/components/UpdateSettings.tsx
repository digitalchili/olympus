import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '@shared/types';
import { applyUpdate, fetchAppVersion, fetchUpdateStatus } from '../lib/api';
import { toErrorMessage } from '../lib/format';

/**
 * The update hook restarts this installation underneath us, so the only reliable
 * completion signal is /api/version reporting a different build than the one that
 * requested the update.
 */
export type UpdateInstallState =
  | { phase: 'requested'; fromVersion: string; toVersion: string | null }
  | { phase: 'restarting'; fromVersion: string; toVersion: string | null }
  | { phase: 'installed'; version: string }
  | { phase: 'timeout' };

interface UpdateSettingsCardProps {
  status: UpdateStatus | null;
  loading: boolean;
  applying: boolean;
  accepted: boolean;
  error: string | null;
  install?: UpdateInstallState | null;
  onRefresh: () => void;
  onRequestUpdate: () => void;
  onReload?: () => void;
}

export function UpdateSettingsCard({
  status,
  loading,
  applying,
  accepted,
  error,
  install = null,
  onRefresh,
  onRequestUpdate,
  onReload,
}: UpdateSettingsCardProps) {
  const updateDisabled = loading
    || applying
    || accepted
    || !status?.updateAvailable
    || !status.updateConfigured;
  const updateTitle = !status
    ? 'Check for updates first'
    : !status.updateConfigured
      ? 'The installation-local update hook is unavailable'
      : !status.updateAvailable
        ? 'No update is available'
        : 'Update this installation';
  const statusError = error ?? status?.error ?? null;

  return (
    <section
      aria-labelledby="software-updates-title"
      className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="software-updates-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Software updates
          </h2>
          <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
            Check this installation for a newer release.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || applying}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Current</dt>
          <dd className="mt-0.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {status ? `v${status.currentVersion}` : '…'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Latest</dt>
          <dd className="mt-0.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {status?.latestVersion ? `v${status.latestVersion}` : 'Unavailable'}
          </dd>
        </div>
      </dl>

      <div className="mt-3 min-h-5 text-xs leading-5">
        {install?.phase === 'installed' ? (
          <p className="inline-flex flex-wrap items-center gap-1.5 text-emerald-600 dark:text-emerald-400" role="status">
            <CheckCircle2 size={14} />
            <span>Updated to v{install.version}. Reload to finish switching over.</span>
            {onReload && (
              <button
                type="button"
                data-update-reload="true"
                onClick={onReload}
                className="rounded-md border border-emerald-600/40 px-2 py-0.5 font-medium text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-400/40 dark:text-emerald-300 dark:hover:bg-emerald-400/10"
              >
                Reload now
              </button>
            )}
          </p>
        ) : install?.phase === 'timeout' ? (
          <p className="text-amber-600 dark:text-amber-400" role="status">
            The update is taking longer than expected. Reload to check which version is installed.
          </p>
        ) : install ? (
          <p className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300" role="status">
            <Loader2 size={14} className="animate-spin" />
            {install.phase === 'restarting'
              ? 'Installing — this installation is restarting…'
              : 'Update requested. Waiting for the installation to restart…'}
          </p>
        ) : accepted ? (
          <p className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400" role="status">
            <CheckCircle2 size={14} />
            Update request accepted. This installation may restart shortly.
          </p>
        ) : !status?.updateConfigured && status ? (
          <p className="text-amber-600 dark:text-amber-400">
            Updating here is disabled because the installation-local update hook is unavailable.
          </p>
        ) : status?.updateAvailable ? (
          <p className="text-zinc-600 dark:text-zinc-300">A newer release is available.</p>
        ) : status && !status.error ? (
          <p className="text-zinc-500 dark:text-zinc-400">This installation is up to date.</p>
        ) : null}
        {statusError && <p className="text-red-600 dark:text-red-400">{statusError}</p>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-update-action="true"
          onClick={onRequestUpdate}
          disabled={updateDisabled}
          title={updateTitle}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          <Download size={14} />
          {applying ? 'Requesting…' : accepted ? 'Update requested' : 'Update'}
        </button>
        {status?.releaseUrl && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Release notes
            <ExternalLink size={13} />
          </a>
        )}
      </div>
    </section>
  );
}

interface UpdateConfirmDialogProps {
  currentVersion: string;
  latestVersion: string;
  applying: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UpdateConfirmDialog({
  currentVersion,
  latestVersion,
  applying,
  error,
  onConfirm,
  onCancel,
}: UpdateConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancel update"
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
        disabled={applying}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-confirm-title"
        className="relative w-full max-w-sm rounded-xl border border-zinc-200 bg-white px-6 py-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 id="update-confirm-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Update this installation?
        </h2>
        <p className="mt-1.5 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
          Update from v{currentVersion} to v{latestVersion}. This sends a request only to this installation&apos;s configured local update hook. Access may be briefly interrupted.
        </p>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="rounded-lg border border-zinc-200 px-3.5 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={applying}
            className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {applying ? 'Requesting…' : 'Update now'}
          </button>
        </div>
      </div>
    </div>
  );
}

const INSTALL_POLL_INTERVAL_MS = 2_500;
const INSTALL_POLL_TIMEOUT_MS = 10 * 60_000;

export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [install, setInstall] = useState<UpdateInstallState | null>(null);
  const installStartedAtRef = useRef(0);

  const loadStatus = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchUpdateStatus(refresh));
    } catch (nextError) {
      setError(toErrorMessage(nextError, 'Failed to check for updates'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  const confirmUpdate = useCallback(async () => {
    setApplying(true);
    setConfirmError(null);
    try {
      await applyUpdate();
      setAccepted(true);
      setConfirming(false);
      if (status) {
        installStartedAtRef.current = Date.now();
        setInstall({
          phase: 'requested',
          fromVersion: status.currentVersion,
          toVersion: status.latestVersion,
        });
      }
    } catch (nextError) {
      setConfirmError(toErrorMessage(nextError, 'Failed to request update'));
    } finally {
      setApplying(false);
    }
  }, [status]);

  // Watch for the restarted installation to report a different build.
  useEffect(() => {
    if (!install || install.phase === 'installed' || install.phase === 'timeout') return;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - installStartedAtRef.current > INSTALL_POLL_TIMEOUT_MS) {
        setInstall({ phase: 'timeout' });
        return;
      }
      try {
        const { version } = await fetchAppVersion();
        if (cancelled) return;
        if (version && version !== install.fromVersion) {
          setInstall({ phase: 'installed', version });
          return;
        }
      } catch {
        // A failed check means the installation is mid-restart, which is expected.
        if (!cancelled && install.phase !== 'restarting') {
          setInstall({ ...install, phase: 'restarting' });
          return;
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), INSTALL_POLL_INTERVAL_MS);
    };

    timer = window.setTimeout(() => void poll(), INSTALL_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [install]);

  return (
    <>
      <UpdateSettingsCard
        status={status}
        loading={loading}
        applying={applying}
        accepted={accepted}
        error={error}
        install={install}
        onRefresh={() => void loadStatus(true)}
        onRequestUpdate={() => {
          setConfirmError(null);
          setConfirming(true);
        }}
        onReload={() => window.location.reload()}
      />
      {confirming && status?.latestVersion && (
        <UpdateConfirmDialog
          currentVersion={status.currentVersion}
          latestVersion={status.latestVersion}
          applying={applying}
          error={confirmError}
          onConfirm={() => void confirmUpdate()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
