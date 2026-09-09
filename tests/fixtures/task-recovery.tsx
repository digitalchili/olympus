import { TaskActivityIndicator } from '../../client/src/components/TaskActivityIndicator';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunFailureBanner } from '../../client/src/components/RunFailureBanner';
import { deriveRunFailureNotice, taskExecutionLabel } from '../../client/src/lib/runFailurePresentation';
import type { TaskAgentRun } from '../../shared/types';
import '../../client/src/styles/globals.css';

const base: TaskAgentRun = { taskId: 'fixture', runId: 'run-1', kind: 'chat', status: 'error', errorCode: 'iteration_limit', startedAt: 1, updatedAt: 2, completedAt: 2, modelResolution: null };
function Fixture() {
  const [run, setRun] = useState<TaskAgentRun>({ ...base, recoveryState: 'blocked' });
  const [draft, setDraft] = useState('Keep this unsent note');
  return <main style={{ maxWidth: 1000, margin: '48px auto', padding: '0 20px', fontFamily: 'sans-serif' }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 32 }}>
      <h1 className="text-lg font-semibold">Verify Country Selection in Contacts</h1>
      <span role="status" className="rounded-full bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">{taskExecutionLabel('in_progress', run)}</span>
    </header>
    <TaskActivityIndicator run={run} />
    <p className="mt-6 mb-6 text-sm text-zinc-600">Changes are saved. Production build verification remains unfinished.</p>
    <RunFailureBanner notice={deriveRunFailureNotice(run)} recoveryState={run.recoveryState}
      onContinue={() => setRun({ ...run, runId: 'run-2', status: 'streaming', startedAt: Date.now(), recoveryState: 'running' })}
      onPause={() => setRun({ ...run, recoveryState: 'blocked' })} />
    <textarea aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} className="w-full rounded-xl border border-zinc-200 p-3 text-sm" />
    <div style={{ display: 'flex', gap: 20, marginTop: 24 }}>
      <button onClick={() => setRun({ ...base, recoveryState: 'pending' })}>Simulate automatic recovery</button>
      <button onClick={() => setRun({ ...base, recoveryState: 'blocked' })}>Simulate stopped task</button>
    </div>
    <p className="mt-3 text-xs text-zinc-500">Disposable UI fixture. No live task or agent is started.</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
