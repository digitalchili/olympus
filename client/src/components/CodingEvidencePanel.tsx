import { useCallback, useEffect, useState } from 'react';
import type { CodingEvidence } from '@shared/coding-evidence';
import { fetchCodingEvidence, interruptTask, runCodingVerification } from '../lib/api';

export function CodingEvidencePanel({ taskId, isStreaming }: { taskId: string; isStreaming: boolean }) {
  const [evidence, setEvidence] = useState<CodingEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    await Promise.all([
      fetchCodingEvidence(taskId).then(checks => setEvidence(checks.evidence)),
    ]);
  }, [taskId]);
  useEffect(() => {
    let active = true;
    const load = () => { if (active) void refresh().catch(() => {}); };
    load(); const timer = setInterval(load, isStreaming || busy || evidence?.status === 'running' ? 1000 : 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh, isStreaming, busy, evidence?.status]);
  const visibleEvidence = evidence && !(evidence.status === 'pending' && isStreaming) ? evidence : null;
  if (!visibleEvidence) return null;
  const running = busy || evidence?.status === 'running';
  const labels = {
    pending: 'Task details', skipped: 'Task details', running: 'Checking project…',
    passed: 'Checks passed', failed: 'Checks need attention', stale: 'Changes need rechecking',
    unconfigured: 'Project checks not set up',
  };
  return <section aria-label="Task checks and recovery" className="mx-auto mb-3 w-full min-w-0 max-w-[760px] text-xs text-zinc-600 dark:text-zinc-300">
    {visibleEvidence && evidence && <div className="flex items-start gap-3">
      <details key={evidence.runId} className="min-w-0 flex-1">
      <summary aria-label={labels[evidence.status]} className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-1 [&::-webkit-details-marker]:hidden">
        <span role="status" className={`font-medium ${evidence.status === 'pending' || evidence.status === 'skipped' ? 'underline' : ''}`}>{labels[evidence.status]}</span>
        {evidence.status === 'running' && evidence.currentCheck && <>
          <span className="min-w-0 max-w-[50%] truncate" title={evidence.currentCheck.command.join(' ')}>{evidence.currentCheck.command.join(' ')}</span>
          <span className="text-zinc-500">· {Math.floor(evidence.currentCheck.durationMs / 1000)}s</span>
        </>}
        {evidence.status !== 'pending' && evidence.status !== 'skipped' && <span className="text-zinc-500 underline">Details</span>}
      </summary>
      <div className="mt-2 max-h-[40vh] overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
      {(evidence.status === 'pending' || evidence.status === 'skipped') && <p>Checks were not run.</p>}
      <p className="mt-2 break-all text-zinc-500">Starting revision {evidence.baseline.head.slice(0, 12)}{evidence.source && <><br />{evidence.status === 'skipped' ? 'Unchanged revision' : 'Checked revision'} {evidence.source.head.slice(0, 12)}</>}</p>
      {evidence.reason && <p className="mt-1">{evidence.reason}</p>}
      {evidence.status !== 'passed' && evidence.status !== 'skipped' && <p className="mt-1">Changed code stays in progress until the required checks pass.</p>}
      {evidence.status === 'running' && evidence.currentCheck && <div className="mt-2">
        <p className="break-all font-medium">Running: {evidence.currentCheck.command.join(' ')} · {(evidence.currentCheck.durationMs / 1000).toFixed(1)}s elapsed</p>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{evidence.currentCheck.output || 'Waiting for command output…'}</pre>
      </div>}
      {evidence.source && <details className="mt-2"><summary>Changed files ({evidence.source.changedFiles.length}) and diff</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{evidence.source.changedFiles.join('\n')}{'\n'}{evidence.source.diff || 'No tracked-file diff.'}</pre></details>}
      <ul className="mt-2 space-y-2">{evidence.checks.map((check, i) => <li key={i}><details><summary className="cursor-pointer break-all">{check.exitCode === 0 && !check.timedOut ? 'Passed' : 'Failed'}: {check.command.join(' ')} · {(check.durationMs / 1000).toFixed(1)}s</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{check.output}</pre></details></li>)}</ul>
      <button disabled={busy || isStreaming || evidence.status === 'running'} className="mt-3 rounded bg-zinc-900 px-3 py-2 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900" onClick={() => {
        setBusy(true); setError(''); void runCodingVerification(taskId).then(result => setEvidence(result.evidence)).catch(e => setError(String(e))).finally(() => setBusy(false));
      }}>{busy ? 'Running checks…' : 'Run checks'}</button>
      </div>
      </details>
      {running && <button disabled={stopping} className="shrink-0 py-1 underline disabled:opacity-40" onClick={() => {
        setStopping(true); setError('');
        void interruptTask(taskId, 'Verification stopped by user').then(refresh).catch(e => setError(String(e))).finally(() => setStopping(false));
      }}>{stopping ? 'Stopping…' : 'Stop checks'}</button>}
    </div>}
    {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}
  </section>;
}
