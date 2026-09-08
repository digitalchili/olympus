import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProjectSyncBlocker, ProjectSyncState } from '@shared/types';
import { ApiError, fetchProjectSyncState, syncProjectFromGitHub } from '../lib/api';
import { toErrorMessage } from '../lib/format';

interface SyncViewProps {
  projectId: string;
  state: ProjectSyncState;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  onSync: () => void;
}

export function ProjectGitHubSyncView({ state, pending, disabled, error, onSync }: SyncViewProps) {
  const { lastSync, blocker } = state;
  return (
    <section aria-label="GitHub sync" className="mt-4 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" disabled={pending || disabled} onClick={onSync} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          <RefreshCw size={14} className={pending ? 'animate-spin' : ''} aria-hidden="true" />
          {pending ? 'Syncing…' : 'Sync latest from GitHub'}
        </button>
        <p role="status" className="text-zinc-500">
          {lastSync ? <>
            <span className="font-medium">{lastSync.updated ? 'Updated' : 'Up to date'}</span>
            {' · Last verified '}
            <time dateTime={new Date(lastSync.verifiedAt).toISOString()}>{new Date(lastSync.verifiedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
            {' · '}<code title={lastSync.currentSha}>{lastSync.currentSha.slice(0, 7)}</code>
          </> : 'Not synced yet'}
        </p>
      </div>
      {lastSync && <p className="mt-1 text-zinc-500">New tasks use this version.</p>}
      {error && <p role="alert" className="mt-2 text-red-600 dark:text-red-400">{error}</p>}
      {blocker && <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <p>{blocker.message}</p>
      </div>}
    </section>
  );
}

export function ProjectGitHubSync({ projectId, refreshKey, disabled, onBusyChange, onSynced }: {
  projectId: string;
  refreshKey: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSynced: () => Promise<void>;
}) {
  const [state, setState] = useState<ProjectSyncState>({ lastSync: null, blocker: null });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (running.current) return;
    let cancelled = false;
    const request = ++generation.current;
    fetchProjectSyncState(projectId).then(result => {
      if (!cancelled && request === generation.current) setState(result);
    }).catch(() => {
      if (!cancelled && request === generation.current) setError('Could not load the last sync. Try syncing again.');
    });
    return () => { cancelled = true; };
  }, [projectId, refreshKey]);

  const sync = async () => {
    if (disabled || running.current) return;
    running.current = true;
    ++generation.current; // A slower status read must not replace the new sync result.
    setPending(true); onBusyChange(true); setError(null);
    try {
      const result = await syncProjectFromGitHub(projectId);
      if (!mounted.current) return;
      setState({ lastSync: result.lastSync, blocker: null });
      try { await onSynced(); } catch { setError('Synced successfully. Refresh the page to reload task changes.'); }
    } catch (cause) {
      if (!mounted.current) return;
      const blocker = cause instanceof ApiError ? cause.details?.blocker as ProjectSyncBlocker | undefined : undefined;
      if (blocker) setState(current => ({ ...current, blocker }));
      else {
        setError(toErrorMessage(cause, 'Could not sync from GitHub'));
        try { setState(await fetchProjectSyncState(projectId)); } catch { /* Keep previous verified evidence. */ }
      }
    } finally {
      running.current = false; setPending(false); onBusyChange(false);
    }
  };

  return <ProjectGitHubSyncView projectId={projectId} state={state} pending={pending} disabled={disabled} error={error} onSync={() => void sync()} />;
}
