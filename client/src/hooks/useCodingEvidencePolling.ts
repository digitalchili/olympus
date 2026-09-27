import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodingEvidence } from '@shared/coding-evidence';
import { fetchCodingEvidence, fetchTaskRecovery, type TaskRecoveryStatus } from '../lib/api';
import { activeProfileIdFromWindow } from '../lib/profileQuery';

/** One pair per task/profile generation; every explicit refresh gets a fresh read. */
export function useCodingEvidencePolling(taskId: string, isStreaming: boolean, busy: boolean) {
  const key = `${activeProfileIdFromWindow()}:${taskId}`;
  const generation = useRef({ key });
  if (generation.current.key !== key) generation.current = { key };
  const scope = generation.current;
  const [value, setValue] = useState<{ scope: typeof scope; evidence: CodingEvidence | null; recovery: TaskRecoveryStatus | null }>({ scope, evidence: null, recovery: null });
  const evidence = value.scope === scope ? value.evidence : null;
  const recovery = value.scope === scope ? value.recovery : null;
  const repairQueued = recovery?.kind === 'verification' && ['pending', 'waiting', 'dispatching'].includes(recovery.state);
  const interval = isStreaming || busy || repairQueued || evidence?.status === 'running' ? 1000 : 10_000;
  const delay = useRef(interval); delay.current = interval;
  const control = useRef<{ scope: typeof scope; refresh: () => Promise<void>; schedule: () => void } | null>(null);

  useEffect(() => {
    let active = true; let inFlight = false; let queued = false; let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
    const current = () => active && generation.current === scope;
    const clear = () => { clearTimeout(timer); timer = undefined; };
    const schedule = () => {
      clear();
      if (current() && !inFlight && !document.hidden) timer = setTimeout(() => { void refresh().catch(() => {}); }, delay.current);
    };
    const read = async () => {
      if (!current()) return;
      inFlight = true; queued = false; const started = revision;
      // A rejected request must not release the slot while its peer is pending.
      const [checks, recoveryResult] = await Promise.allSettled([fetchCodingEvidence(taskId), fetchTaskRecovery(taskId)]);
      if (!current()) return;
      inFlight = false;
      if (started === revision) {
        setValue(previous => ({ scope,
          evidence: checks.status === 'fulfilled' ? checks.value.evidence : previous.scope === scope ? previous.evidence : null,
          recovery: recoveryResult.status === 'fulfilled' ? recoveryResult.value.recovery : previous.scope === scope ? previous.recovery : null,
        }));
        for (const waiter of waiters.splice(0)) {
          if (checks.status === 'rejected') waiter.reject(checks.reason);
          else if (recoveryResult.status === 'rejected') waiter.reject(recoveryResult.reason);
          else waiter.resolve();
        }
      }
      if (queued && !document.hidden) void read();
      else schedule();
    };
    const refresh = () => {
      if (!current()) return Promise.resolve();
      clear(); revision++; queued = true;
      const completed = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
      if (!inFlight && !document.hidden) void read();
      return completed;
    };
    const visibility = () => { clear(); if (!document.hidden) void refresh().catch(() => {}); };
    control.current = { scope, refresh, schedule };
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) void refresh().catch(() => {});
    return () => {
      active = false; clear(); document.removeEventListener('visibilitychange', visibility);
      for (const waiter of waiters.splice(0)) waiter.resolve();
      if (control.current?.scope === scope) control.current = null;
    };
  }, [scope, taskId]);
  useEffect(() => { if (control.current?.scope === scope) control.current.schedule(); }, [interval, scope]);
  const refresh = useCallback(() => control.current?.scope === scope ? control.current.refresh() : Promise.resolve(), [scope]);
  const isCurrent = useCallback(() => generation.current === scope && control.current?.scope === scope, [scope]);
  return { evidence, recovery, repairQueued, refresh, isCurrent };
}
