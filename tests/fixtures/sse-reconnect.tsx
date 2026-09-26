import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LiveChatRun, TaskMessagesPage } from '../../shared/types';
import { useChat } from '../../client/src/hooks/useChat';
import { reconcilePersistedTaskRun } from '../../client/src/lib/store';
import { RunFailureBanner } from '../../client/src/components/RunFailureBanner';
import '../../client/src/styles/globals.css';

let terminal: 'done' | 'error' | 'stopped' = 'done';
let disconnected = false;
let posts = 0;
const run = (status: LiveChatRun['status']): LiveChatRun => ({
  taskId: 'fixture-sse', sessionId: 'fixture-sse', runId: 'fixture-run', kind: 'chat', status,
  startedAt: 1, updatedAt: 2, messages: [
    { id: 'user', task_id: 'fixture-sse', role: 'user', content: 'Check the saved report.', created_at: 1 },
    { id: 'assistant', task_id: 'fixture-sse', role: 'assistant', content: status === 'streaming' ? 'Checking the report…' : 'Saved work recovered from durable history.', created_at: 2 },
  ],
});
class FixtureEventSource {
  static OPEN = 1;
  static CLOSED = 2;
  static current: FixtureEventSource;
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    FixtureEventSource.current = this;
    queueMicrotask(() => {
      this.open();
      this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', run: run('streaming') }) });
    });
  }
  open() { this.readyState = FixtureEventSource.OPEN; this.onopen?.(); }
  disconnect() { disconnected = true; this.readyState = 0; this.onerror?.(); }
  close() { this.readyState = FixtureEventSource.CLOSED; }
}
window.EventSource = FixtureEventSource as unknown as typeof EventSource;
window.fetch = async (_input, init) => {
  if (init?.method && init.method !== 'GET') { posts++; throw new Error('Fixture forbids task submission'); }
  const current = run(disconnected ? terminal : 'streaming');
  const page: TaskMessagesPage = {
    messages: current.messages,
    pageInfo: { hasOlder: false, olderCursor: null },
    latestAgentRun: { runId: current.runId, taskId: current.taskId, kind: 'chat', status: current.status,
      startedAt: 1, updatedAt: 2, completedAt: disconnected ? 2 : null, modelResolution: null },
  };
  return Response.json(page);
};

function Fixture() {
  const chat = useChat(reconcilePersistedTaskRun);
  const [draft, setDraft] = useState('Keep this unsent note');
  useEffect(() => { void chat.loadMessages('fixture-sse'); }, [chat.loadMessages]);
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <h1 className="text-lg font-semibold">Reconnect with saved task history</h1>
    <p className="text-sm text-zinc-500">Real chat hook with synthetic HTTP/SSE. No task or model is started.</p>
    <p role="status">Connection: {chat.connectionState} · Task: {chat.isStreaming ? 'running' : 'not running'} · Task POSTs: {posts}</p>
    <div className="space-y-3 rounded-xl border p-4">{chat.messages.map(message => <p key={message.id}>{message.content}</p>)}</div>
    <RunFailureBanner notice={chat.runFailureNotice} />
    <label className="block">Unsent message<textarea aria-label="Unsent message" className="mt-2 block w-full rounded-xl border p-3" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <label className="block">Missed terminal event <select className="ml-2 rounded border p-2" onChange={event => { terminal = event.target.value as typeof terminal; }}><option value="done">Done</option><option value="error">Failed</option><option value="stopped">Stopped</option></select></label>
    <div className="flex flex-wrap gap-4"><button className="underline" onClick={() => FixtureEventSource.current.disconnect()}>Disconnect before completion</button><button className="underline" onClick={() => FixtureEventSource.current.open()}>Reconnect after snapshot expiry</button></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
