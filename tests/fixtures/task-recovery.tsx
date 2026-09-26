import { TaskActivityIndicator } from '../../client/src/components/TaskActivityIndicator';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunFailureBanner } from '../../client/src/components/RunFailureBanner';
import { InputToolbar } from '../../client/src/components/InputToolbar';
import { deriveRunFailureNotice, taskExecutionLabel } from '../../client/src/lib/runFailurePresentation';
import type { TaskAgentRun } from '../../shared/types';
import '../../client/src/styles/globals.css';

const base: TaskAgentRun = { taskId: 'fixture', runId: 'run-1', kind: 'chat', status: 'error', errorCode: 'worker_restarted', startedAt: 1, updatedAt: 2, completedAt: 2, modelResolution: null };
function Fixture() {
  const [run, setRunValue] = useState<TaskAgentRun>(() => JSON.parse(sessionStorage.getItem('recovery-fixture') || 'null') ?? { ...base, recoveryState: 'blocked' });
  const setRun = (next: TaskAgentRun) => { sessionStorage.setItem('recovery-fixture', JSON.stringify(next)); setRunValue(next); };
  const [draft, setDraft] = useState('Keep this unsent note');
  const [actions, setActions] = useState<string[]>([]);
  const [modelPickerRequest, setModelPickerRequest] = useState(0);
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<any>(null);
  return <main style={{ maxWidth: 1000, margin: '48px auto', padding: '0 20px', fontFamily: 'sans-serif' }}>
    <header className="mb-8 flex items-center justify-between gap-4">
      <h1 className="text-lg font-semibold">Task recovery · simulated responses</h1>
      <span role="status" className="rounded-full bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">{taskExecutionLabel('in_progress', run)}</span>
    </header>
    <TaskActivityIndicator run={run} />
    <p className="mb-6 text-sm text-zinc-600">Disposable UI fixture. No live task, model, login or network request is started.</p>
    <label>Failure <select className="m-3 rounded border p-2" value={run.errorCode ?? 'provider_error'} onChange={e => setRun({ ...base, errorCode: e.target.value, recoveryState: 'blocked' })}>
      {['worker_restarted','openai_auth_required','openai_auth_unavailable','auth_error','rate_limit','quota_exhausted','model_error','provider_error'].map(code => <option key={code}>{code}</option>)}
    </select></label>
    <RunFailureBanner notice={deriveRunFailureNotice(run)} recoveryState={run.recoveryState} recoveryWaitReason={run.recoveryWaitReason}
      onContinue={() => { setActions([...actions, 'Explicit Continue']); setRun({ ...run, runId: 'run-2', status: 'streaming', startedAt: Date.now(), recoveryState: 'running', recoveryWaitReason: null }); }}
      onSendQueued={() => { setActions([...actions, 'Send queued message']); setRun({ ...run, recoveryState: 'running', recoveryWaitReason: null, status: 'streaming' }); }}
      onAction={action => { setActions([...actions, action]); if (action === 'model_picker') setModelPickerRequest(value => value + 1); }}
      onOpenAIAuth={() => setActions([...actions, 'OpenAI action'])}
      onPause={() => setRun({ ...run, recoveryState: 'blocked', recoveryWaitReason: null })} />
    <textarea aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} className="w-full rounded-xl border border-zinc-200 p-3 text-sm" />
    <InputToolbar modelPickerRequest={modelPickerRequest} model={model} provider="fixture" reasoningEffort={reasoning}
      defaults={{ model: 'sample', provider: 'fixture', reasoningEffort: 'medium' }}
      modelGroups={[{ provider: 'fixture', models: [{ id: 'sample', name: 'Sample', contextLength: 1000 }] }] as any}
      onModelChange={setModel} onReasoningEffortChange={setReasoning} />
    <div className="mt-6 flex flex-wrap gap-4">
      <button onClick={() => setRun({ ...base, recoveryState: 'pending', recoveryWaitReason: 'queued_message' })}>Queue user message</button>
      <button onClick={() => setRun({ ...base, recoveryState: 'pending', recoveryWaitReason: 'awaiting_input' })}>Await answer</button>
      <button onClick={() => setRun({ ...base, recoveryState: 'pending', recoveryWaitReason: null })}>Remove queued message</button>
    </div>
    <p className="mt-3 text-sm" role="status">Actions: {actions.join(', ') || 'None'}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
