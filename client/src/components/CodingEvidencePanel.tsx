import { useCallback, useEffect, useState } from 'react';
import type { CodingEvidence } from '@shared/coding-evidence';
import { codingFailureDetails } from '@shared/coding-failure';
import { fetchCodingEvidence, fetchTaskRecovery, pauseTaskRecovery, interruptTask, runCodingVerification, type TaskRecoveryStatus } from '../lib/api';

export function CodingEvidencePanel({ taskId, isStreaming, onViewAgentReply }: { taskId: string; isStreaming: boolean; onViewAgentReply?: () => void }) {
  const [evidence, setEvidence] = useState<CodingEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<TaskRecoveryStatus | null>(null);
  const repairQueued = recovery?.kind === 'verification' && ['pending', 'waiting', 'dispatching'].includes(recovery.state);
  const refresh = useCallback(async () => {
    await Promise.all([
      fetchCodingEvidence(taskId).then(checks => setEvidence(checks.evidence)),
      fetchTaskRecovery(taskId).then(result => setRecovery(result.recovery)),
    ]);
  }, [taskId]);
  useEffect(() => {
    let active = true;
    const load = () => { if (active) void refresh().catch(() => {}); };
    load(); const timer = setInterval(load, isStreaming || busy || repairQueued || evidence?.status === 'running' ? 1000 : 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh, isStreaming, busy, repairQueued, evidence?.status]);
  const visibleEvidence = evidence && !(evidence.status === 'pending' && isStreaming) ? evidence : null;
  if (!visibleEvidence) return null;
  const running = busy || evidence?.status === 'running';
  const finished = !running && ['passed', 'failed'].includes(evidence?.status ?? '');
  const skippedChanges = evidence?.status === 'skipped' && Boolean(evidence.source?.changedFiles.length);
  const needsAttention = skippedChanges || ['failed', 'stale', 'unconfigured'].includes(evidence?.status ?? '');
  const labels = {
    pending: 'Task details', skipped: skippedChanges ? 'Verification needed' : 'Checks not needed for this turn', running: 'Checking project…',
    passed: 'Checks passed', failed: 'Checks failed', stale: 'Changes need rechecking',
    unconfigured: 'Project checks not set up',
  };
  return <section aria-label="Task checks and recovery" className="mx-auto mb-3 w-full min-w-0 max-w-[760px] text-xs text-zinc-600 dark:text-zinc-300">
    {visibleEvidence && evidence && <div className="flex items-start gap-3">
      <details key={`${evidence.runId}:${running}`} open={running || needsAttention || undefined} className="min-w-0 flex-1">
      <summary aria-label={running ? 'Running checks' : labels[evidence.status]} className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-1 [&::-webkit-details-marker]:hidden">
        <span role="status" className={`font-medium ${evidence.status === 'pending' || evidence.status === 'skipped' ? 'underline' : ''}`}>{running ? 'Running checks…' : labels[evidence.status]}</span>
        {finished && <span className="text-zinc-500">Finished <time dateTime={new Date(evidence.updatedAt).toISOString()}>{new Date(evidence.updatedAt).toLocaleString()}</time></span>}
        {evidence.status === 'running' && evidence.currentCheck && <>
          <span className="min-w-0 max-w-[50%] truncate" title={evidence.currentCheck.command.join(' ')}>{evidence.currentCheck.command.join(' ')}</span>
          <span className="text-zinc-500">· {Math.floor(evidence.currentCheck.durationMs / 1000)}s</span>
        </>}
        {evidence.status !== 'pending' && evidence.status !== 'skipped' && <span className="text-zinc-500 underline">Details</span>}
      </summary>
      <div className="mt-2 max-h-[40vh] overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
      {running && <p role="status" className="mb-3 font-medium">{evidence.status === 'running' ? 'Checking the project. Results will appear here.' : 'Starting checks. Waiting for the project…'}</p>}
      {!running && <ul className="mt-2 space-y-2">{evidence.checks.map((check, i) => {
        const failed = check.exitCode !== 0 || check.timedOut;
        const output = check.output.replace(/\u001b\[[0-9;]*m/g, '');
        const failure = codingFailureDetails(check);
        return <li key={`${i}:${evidence.updatedAt}`}>
          <details open={failed || undefined}><summary className="cursor-pointer break-all font-medium">{failed ? failure.summary : 'Passed'}: {check.command.join(' ')} · {(check.durationMs / 1000).toFixed(1)}s</summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">{failed ? failure.excerpt : output}</pre>
            {failed && <details className="mt-2"><summary className="cursor-pointer underline">Full command output</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{output}</pre></details>}
          </details>
        </li>;
      })}</ul>}
      {(evidence.status === 'pending' || evidence.status === 'skipped') && <p>Checks were not run.</p>}
      {skippedChanges && <p className="mt-1 font-medium">The response is finished, but existing code changes still need verification before this task moves to review. Run checks below.</p>}
      <details className="mt-3"><summary className="cursor-pointer text-zinc-500">Revision and changed files</summary>
      <p className="mt-2 break-all text-zinc-500">Starting revision {evidence.baseline.head.slice(0, 12)}{evidence.source && <><br />{evidence.status === 'skipped' ? 'Unchanged revision' : 'Checked revision'} {evidence.source.head.slice(0, 12)}</>}</p>
      {evidence.source && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">Changed files ({evidence.source.changedFiles.length}){'\n'}{evidence.source.changedFiles.join('\n')}{'\n'}{evidence.source.diff || 'No tracked-file diff.'}</pre>}
      </details>
      {!running && evidence.reason && <p className="mt-1">{evidence.reason}</p>}
      {needsAttention && <p className="mt-1">This task needs passing checks before it can move to review automatically.</p>}
      {evidence.status === 'running' && evidence.currentCheck && <div className="mt-2">
        <p className="break-all font-medium">Running: {evidence.currentCheck.command.join(' ')} · {(evidence.currentCheck.durationMs / 1000).toFixed(1)}s elapsed</p>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{evidence.currentCheck.output || 'Waiting for command output…'}</pre>
      </div>}
      </div>
      {!running && evidence.status === 'failed' && <p role="status" className="mt-3">{repairQueued
        ? 'The agent will repair these failures and run checks again automatically. Waiting for the task to be available.'
        : recovery?.kind === 'verification' && recovery.state === 'blocked'
          ? recovery.reason
          : 'The checks failed. Run checks again to retry; a failed result will return to the agent for repair.'}</p>}
      {!running && evidence.status === 'failed' && !repairQueued && onViewAgentReply && <button type="button" className="mt-2 block underline" onClick={onViewAgentReply}>Read the agent’s explanation</button>}
      <button disabled={busy || isStreaming || repairQueued || evidence.status === 'running'} className="mt-3 rounded bg-zinc-900 px-3 py-2 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900" onClick={() => {
        setBusy(true); setError(''); void runCodingVerification(taskId).then(result => { setEvidence(result.evidence); return refresh(); }).catch(e => setError(String(e))).finally(() => setBusy(false));
      }}>{running ? 'Running checks…' : evidence.checks.length ? 'Run checks again' : 'Run checks'}</button>
      {repairQueued && <button disabled={stopping} className="ml-3 underline disabled:opacity-40" onClick={() => {
        setStopping(true); setError(''); void pauseTaskRecovery(taskId).then(refresh).catch(e => setError(String(e))).finally(() => setStopping(false));
      }}>{stopping ? 'Pausing…' : 'Pause automatic repair'}</button>}
      </details>
      {running && <button disabled={stopping} className="shrink-0 py-1 underline disabled:opacity-40" onClick={() => {
        setStopping(true); setError('');
        void interruptTask(taskId, 'Verification stopped by user').then(refresh).catch(e => setError(String(e))).finally(() => setStopping(false));
      }}>{stopping ? 'Stopping…' : 'Stop checks'}</button>}
    </div>}
    {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}
  </section>;
}
