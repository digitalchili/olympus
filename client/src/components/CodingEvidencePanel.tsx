import { useCallback, useEffect, useState } from 'react';
import type { CodingEvidence } from '@shared/coding-evidence';
import { fetchCodingEvidence, fetchTaskRecovery, pauseTaskRecovery, runCodingVerification, type TaskRecoveryStatus } from '../lib/api';

export function CodingEvidencePanel({ taskId, isStreaming }: { taskId: string; isStreaming: boolean }) {
  const [evidence, setEvidence] = useState<CodingEvidence | null>(null);
  const [recovery, setRecovery] = useState<TaskRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const [checks, continuation] = await Promise.all([fetchCodingEvidence(taskId), fetchTaskRecovery(taskId)]);
    setEvidence(checks.evidence); setRecovery(continuation.recovery);
  }, [taskId]);
  useEffect(() => {
    let active = true;
    const load = () => { if (active) void refresh().catch(() => {}); };
    load(); const timer = setInterval(load, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh, isStreaming]);
  const waiting = recovery && ['pending','waiting','dispatching','exhausted','blocked'].includes(recovery.state);
  if (!evidence && !waiting) return null;
  return <section aria-label="Coding verification and recovery" className="mx-auto mb-3 w-full min-w-0 max-w-[760px] max-h-[40vh] overflow-y-auto rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-700">
    {waiting && <div role="status" className="mb-2 space-y-1">
      <div className="font-medium">Recovery: {recovery.state} · {recovery.attempts}/2 attempts</div>
      {recovery.reason && <p>{recovery.reason}</p>}
      {recovery.checkpoint?.saved && <p>Continuation state saved. Project files are not backed up by this receipt.</p>}
      {['pending','waiting','dispatching'].includes(recovery.state) && <button className="underline" onClick={() => { void pauseTaskRecovery(taskId).then(refresh).catch(e => setError(String(e))); }}>Pause automatic recovery</button>}
    </div>}
    {evidence && <details open={evidence.status !== 'passed'}>
      <summary className="cursor-pointer font-medium">Code verification: {evidence.status}</summary>
      <p className="mt-2 break-all text-zinc-500">Starting revision {evidence.baseline.head.slice(0, 12)}{evidence.source && <><br />Checked revision {evidence.source.head.slice(0, 12)}</>}</p>
      {evidence.reason && <p className="mt-1">{evidence.reason}</p>}
      {evidence.status !== 'passed' && <p className="mt-1">Changed code stays in progress until the required checks pass.</p>}
      {evidence.source && <details className="mt-2"><summary>Changed files ({evidence.source.changedFiles.length}) and diff</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{evidence.source.changedFiles.join('\n')}{'\n'}{evidence.source.diff || 'No tracked-file diff.'}</pre></details>}
      <ul className="mt-2 space-y-2">{evidence.checks.map((check, i) => <li key={i}><details><summary className="cursor-pointer break-all">{check.exitCode === 0 && !check.timedOut ? 'Passed' : 'Failed'}: {check.command.join(' ')} · {(check.durationMs / 1000).toFixed(1)}s</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{check.output}</pre></details></li>)}</ul>
      <button disabled={busy || isStreaming || evidence.status === 'running'} className="mt-3 rounded bg-zinc-900 px-3 py-2 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900" onClick={() => {
        setBusy(true); setError(''); void runCodingVerification(taskId).then(result => setEvidence(result.evidence)).catch(e => setError(String(e))).finally(() => setBusy(false));
      }}>{busy ? 'Running checks…' : 'Run checks'}</button>
    </details>}
    {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}
  </section>;
}
