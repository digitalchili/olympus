import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { HermesUpdatePhase, HermesUpdateStatus } from '@shared/hermes-updates';
import { ApiError, applyHermesUpdate, fetchHermesUpdateStatus } from '../lib/api';

const activePhases = new Set<HermesUpdatePhase>(['preparing', 'draining', 'backing_up', 'installing', 'verifying']);
const labels: Record<HermesUpdatePhase, string> = { idle: 'Ready', preparing: 'Preparing the update', draining: 'Waiting for current work to finish', backing_up: 'Backing up local state', installing: 'Installing the compatible runtime', verifying: 'Verifying the running installation', completed: 'Update finished', failed: 'Update failed', rolled_back: 'Previous installation restored', interrupted: 'Update interrupted — check recovery guidance' };
const versionLabel = (value: string | null) => value ? `v${value.replace(/^v/, '')}` : 'Unavailable';
const verified = (status: HermesUpdateStatus) => status.operation?.phase === 'completed' && status.current.available && status.current.revision === status.operation.targetRevision;
const needsObservation = (status: HermesUpdateStatus | null) => Boolean(status?.operation && (activePhases.has(status.operation.phase) || status.operation.phase === 'completed' && !verified(status)));

interface CardProps {
  status: HermesUpdateStatus | null; loading: boolean; applying: boolean; observingRequest: boolean; error: string | null;
  onRefresh: () => void; onRequestUpdate: () => void;
}
export function HermesUpdateCard({ status, loading, applying, observingRequest, error, onRefresh, onRequestUpdate }: CardProps) {
  const operation = status?.operation;
  const active = Boolean(operation && activePhases.has(operation.phase));
  const container = status?.current.installation === 'docker' || status?.method === 'docker' || status?.method === 'dokploy';
  const ready = Boolean(status?.canApply && status.target && status.targetOlympusVersion && !status.error);
  const actionDisabled = !ready || loading || applying || observingRequest || needsObservation(status) || Boolean(error);
  return <section aria-labelledby="hermes-updates-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
    <div className="flex items-start justify-between gap-4"><div><h2 id="hermes-updates-title" className="text-sm font-medium">Hermes agent</h2><p className="mt-1 text-sm text-zinc-500">Update the agent runtime used by this installation and all its profiles.</p></div><button type="button" onClick={onRefresh} disabled={loading || applying} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs dark:border-zinc-700 disabled:opacity-40"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Check Hermes</button></div>
    <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60"><div><dt className="text-xs text-zinc-500">Running version</dt><dd className="mt-0.5 text-sm font-medium">{status ? versionLabel(status.current.version) : '…'}</dd>{status?.current.revision && <dd className="mt-1 font-mono text-xs text-zinc-500">{status.current.revision.slice(0, 12)}</dd>}</div><div><dt className="text-xs text-zinc-500">Latest compatible</dt><dd className="mt-0.5 text-sm font-medium">{versionLabel(status?.target?.version ?? null)}</dd>{status?.target && <dd className="mt-1 font-mono text-xs text-zinc-500">{status.target.revision.slice(0, 12)}</dd>}</div></dl>
    {status?.target && <p className="mt-2 text-xs text-zinc-500">Tested with Olympus {versionLabel(status.targetOlympusVersion)}. Compatibility follows Olympus releases.</p>}
    <div className="mt-3 space-y-2 text-xs leading-5" role="status">
      {status && operation && verified(status) ? <p className="text-emerald-700 dark:text-emerald-300">Updated to Hermes {versionLabel(status.current.version ?? operation.targetVersion)}. The running revision is verified.</p>
        : active ? <p className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{labels[operation!.phase]}</p>
          : operation?.phase === 'completed' ? <p className="text-amber-700 dark:text-amber-300">The updater finished, but the running Hermes revision is not yet verified. Checking status…</p>
            : operation && ['failed', 'rolled_back', 'interrupted'].includes(operation.phase) ? <p className="text-amber-700 dark:text-amber-300">{labels[operation.phase]}. {operation.message}</p>
              : observingRequest ? <p>Checking whether the update request was accepted. Do not submit another request.</p>
                : status?.current.available && status.target && !status.error && status.current.revision === status.target.revision ? <p>Hermes is on the latest compatible revision.</p>
                  : status?.updateAvailable ? <p>A tested compatible update is available.</p> : null}
      {active && operation?.message && <p className="text-zinc-500">{operation.message}</p>}
      {!container && (status?.current.installation === 'source' || status?.method === 'native') && <p className="text-zinc-500">Native installation: Hermes updates separately to the revision tested with your installed Olympus release.</p>}
      {container && <p className="text-zinc-500">{status?.method === 'dokploy' ? 'Dokploy' : 'Docker'} installation: this updates Hermes through a paired Olympus deployment with its existing data volumes.</p>}
      {status && !status.canApply && status.reason && <p className="text-amber-700 dark:text-amber-300">{status.reason}</p>}
      {status?.method === 'unavailable' && <p className="text-zinc-500">This installation needs a supported local updater before it can update Hermes here.</p>}
      {(error || status?.error) && <p role="alert" className="text-red-600 dark:text-red-400">{error ?? status?.error}</p>}
    </div>
    {status && !status.canApply && <a href="https://github.com/digitalchili/olympus/blob/main/docs/hermes-updates.md" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs underline">Setup and recovery guide <ExternalLink size={12} /></a>}
    <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" data-hermes-update-action="true" disabled={actionDisabled} onClick={onRequestUpdate} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"><Download size={14} />{applying ? 'Requesting…' : 'Update Hermes'}</button>{status?.target?.releaseUrl && <a href={status.target.releaseUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs dark:border-zinc-700">Release notes <ExternalLink size={13} /></a>}</div>
  </section>;
}

interface ConfirmationTarget { revision: string; version: string; olympusVersion: string; currentVersion: string | null; method: HermesUpdateStatus['method'] }
export function HermesUpdateConfirmDialog({ target, applying, stale, error, onConfirm, onCancel }: { target: ConfirmationTarget; applying: boolean; stale: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(applying); busy.current = applying;
  const close = useRef(onCancel); close.current = onCancel;
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    const focus = () => (cancel.current?.disabled ? node : cancel.current ?? node).focus();
    const focusIn = (event: FocusEvent) => { if (!node.contains(event.target as Node)) focus(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy.current) close.current(); }
      if (event.key !== 'Tab') return;
      event.preventDefault(); event.stopPropagation();
      const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (event.shiftKey ? buttons.at(-1) : buttons[0]) : buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
      (next ?? node).focus();
    };
    document.addEventListener('focusin', focusIn); document.addEventListener('keydown', keyDown, true); focus();
    return () => { document.removeEventListener('focusin', focusIn); document.removeEventListener('keydown', keyDown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const container = target.method === 'docker' || target.method === 'dokploy';
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="hermes-update-confirm-title" className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"><h2 id="hermes-update-confirm-title" className="text-base font-semibold">Update Hermes?</h2><p className="mt-2 text-sm text-zinc-500">Update from {versionLabel(target.currentVersion)} to Hermes {versionLabel(target.version)}.</p><p className="mt-2 text-sm text-zinc-500">{container ? `This performs a paired Olympus ${versionLabel(target.olympusVersion)} deployment through ${target.method === 'dokploy' ? 'Dokploy' : 'Docker'}.` : 'This updates the local Hermes runtime for all profiles.'} The updater waits for current work, backs up local state and verifies the replacement. Access may be briefly interrupted.</p><p className="mt-2 font-mono text-xs text-zinc-500">Target revision: {target.revision.slice(0, 12)}</p>{stale && <p role="alert" className="mt-3 text-sm text-amber-700 dark:text-amber-300">The available target or installation state changed. Close this dialog and check the current target before updating.</p>}{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button ref={cancel} type="button" disabled={applying} onClick={onCancel} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 disabled:opacity-40">Cancel</button><button type="button" disabled={applying || stale} onClick={onConfirm} className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{applying ? 'Requesting…' : 'Update now'}</button></div></div></div>;
}

export function HermesUpdateSettings() {
  const [status, setStatus] = useState<HermesUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [observationTick, setObservationTick] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationTarget | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [observingRequest, setObservingRequest] = useState(false);
  const requestInFlight = useRef(false);
  const observedOperation = useRef<string | null>(null);
  const previousOperation = useRef<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const load = useCallback(async (refresh: boolean, showLoading = true) => {
    const generation = ++sequence.current;
    if (showLoading) setLoading(true);
    try {
      const next = await fetchHermesUpdateStatus(refresh);
      if (!mounted.current || generation !== sequence.current) return;
      setStatus(next); setError(null);
      if (next.operation && (observedOperation.current === next.operation.id || !observedOperation.current && next.operation.id !== previousOperation.current)) setObservingRequest(false);
    } catch {
      if (mounted.current && generation === sequence.current) setError('Hermes status is unavailable. Checking again; an interrupted connection does not confirm that an update finished.');
    } finally { if (mounted.current && generation === sequence.current) { setLoading(false); setObservationTick(value => value + 1); } }
  }, []);
  useEffect(() => { mounted.current = true; void load(false); return () => { mounted.current = false; sequence.current++; }; }, [load]);
  useEffect(() => {
    if (!observingRequest && !needsObservation(status) && !error) return;
    const timer = window.setTimeout(() => void load(false, false), 3_000);
    return () => window.clearTimeout(timer);
  }, [status, error, observingRequest, observationTick, load]);
  const stale = Boolean(confirmation && (!status?.canApply || status.target?.revision !== confirmation.revision || status.targetOlympusVersion !== confirmation.olympusVersion || status.method !== confirmation.method || error));
  async function apply() {
    if (!confirmation || stale || requestInFlight.current) return;
    requestInFlight.current = true;
    previousOperation.current = status?.operation?.id ?? null;
    observedOperation.current = null;
    setApplying(true); setConfirmError(null); setObservingRequest(true);
    try {
      const result = await applyHermesUpdate({ targetRevision: confirmation.revision, targetOlympusVersion: confirmation.olympusVersion });
      if (!mounted.current) return;
      observedOperation.current = result.operationId;
      setConfirmation(null);
      void load(false, false);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        setObservingRequest(false);
        setConfirmError('The update could not start. Close this dialog, check the current status and confirm the target again.');
      } else {
        setConfirmation(null);
        setError('The update request outcome is not yet known. Checking status before allowing another request.');
      }
      void load(true, false);
    } finally { requestInFlight.current = false; if (mounted.current) setApplying(false); }
  }
  return <><HermesUpdateCard status={status} loading={loading} applying={applying} observingRequest={observingRequest} error={error} onRefresh={() => void load(true)} onRequestUpdate={() => {
    if (!status?.canApply || !status.target || !status.targetOlympusVersion || requestInFlight.current || observingRequest || error) return;
    setConfirmError(null);
    setConfirmation({ revision: status.target.revision, version: status.target.version, olympusVersion: status.targetOlympusVersion, currentVersion: status.current.version, method: status.method });
  }} />{confirmation && <HermesUpdateConfirmDialog target={confirmation} applying={applying} stale={stale} error={confirmError} onConfirm={() => void apply()} onCancel={() => setConfirmation(null)} />}</>;
}
