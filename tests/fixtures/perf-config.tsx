import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ProfileProvider } from '../../client/src/contexts/ProfileContext';
import { TaskChat } from '../../client/src/components/TaskChat';
import type { LiveChatRun } from '../../shared/types';
import '../../client/src/styles/globals.css';

// Real composer/config/chat hooks; only HTTP/SSE are synthetic. No server or model.
const defaults = { model: 'fixture-default', provider: 'fixture', reasoningEffort: 'medium', baseUrl: null, apiMode: null, showReasoning: true };
const selected = { model: 'saved-model', provider: 'saved-provider', reasoningEffort: 'high' };
const profiles = [{ id: 'named', displayName: 'Fixture profile', label: 'Fixture profile', active: true, isDefault: true }];
let catalogHeld = true, failSettings = new URLSearchParams(location.search).get('settings') === 'fail';
let run: LiveChatRun | null = null;
const catalogWaiters: Array<() => void> = [], posts: unknown[] = [], listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());
class FixtureEventSource {
  static OPEN = 1; static CLOSED = 2; static current: FixtureEventSource;
  readyState = 0; onopen?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
  constructor() { FixtureEventSource.current = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  close() { this.readyState = 2; }
  emit() { if (this.readyState === 1 && run) this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', run }) }); }
}
window.EventSource = FixtureEventSource as unknown as typeof EventSource;
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin), path = url.pathname;
  if (url.origin !== location.origin || !path.startsWith('/api/')) throw Error('Fixture forbids external requests');
  if (path.endsWith('/models')) {
    if (catalogHeld) await new Promise<void>(resolve => catalogWaiters.push(resolve));
    return Response.json({ groups: [], defaultModel: 'catalog-must-not-select', activeProvider: 'different-provider' });
  }
  if (path.endsWith('/agent-settings')) return failSettings ? Response.json({ error: 'Fixture settings unavailable' }, { status: 503 }) : Response.json({ defaults, task: selected });
  if (path.endsWith('/defaults')) return Response.json(defaults);
  if (path.endsWith('/profiles')) return Response.json({ profiles });
  if (path.endsWith('/messages')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (JSON.stringify(body.settings) !== JSON.stringify({ ...selected, mode: 'task' })) throw Error('Fixture settings drift');
      posts.push({ ...body, profile: url.searchParams.get('profile'), catalogHeld }); changed();
      const startedAt = Date.now();
      run = { taskId: 'perf-task', sessionId: 'perf-task', runId: `fixture-${posts.length}`, kind: 'chat', status: 'streaming', startedAt, updatedAt: startedAt,
        messages: [{ id: `user-${posts.length}`, task_id: 'perf-task', role: 'user', content: body.content, created_at: startedAt }] };
      setTimeout(() => {
        run!.messages.push({ id: `assistant-${posts.length}`, task_id: 'perf-task', role: 'assistant', content: 'First synthetic answer while the model catalog is still held.', created_at: Date.now() });
        FixtureEventSource.current.emit();
        setTimeout(() => { run!.status = 'done'; FixtureEventSource.current.emit(); }, 300);
      }, 60);
      return Response.json({ runId: run.runId }, { status: 202 });
    }
    return Response.json({ messages: run?.messages ?? [], pageInfo: { hasOlder: false, olderCursor: null }, latestAgentRun: null });
  }
  if (path.endsWith('/queued-message')) return Response.json({ queuedMessage: null });
  if (path.endsWith('/interactions')) return Response.json({ interactions: [] });
  if (path.endsWith('/background-work')) return Response.json({ available: true, work: [], canStop: false });
  if (path.endsWith('/collaboration-grants')) return Response.json({ grants: [] });
  if (path.endsWith('/verification')) return Response.json({ evidence: null });
  if (path.endsWith('/recovery')) return Response.json({ recovery: null });
  throw Error(`Unexpected fixture request: ${path}`);
};

function Fixture() {
  const [, repaint] = useState(0);
  useEffect(() => { const refresh = () => repaint(n => n + 1); listeners.add(refresh); return () => { listeners.delete(refresh); }; }, []);
  return <main className="mx-auto flex h-screen max-w-5xl flex-col p-4">
    <header className="space-y-2 border-b p-3 text-sm">
      <h1 className="font-semibold">Slow model catalog · real Olympus composer</h1>
      <p>No provider calls or real task writes. Send a message before releasing the catalog.</p>
      <p role="status">Catalog: {catalogHeld ? 'held' : 'released'} · Task POSTs: {posts.length}</p>
      <button className="mr-4 underline" onClick={() => { catalogHeld = false; catalogWaiters.splice(0).forEach(resolve => resolve()); changed(); }}>Release catalog</button>
      <button className="underline" onClick={() => { failSettings = false; changed(); }}>Allow settings retry</button>
      <pre className="max-h-28 overflow-auto text-xs">{JSON.stringify(posts, null, 2)}</pre>
    </header>
    <BrowserRouter><ProfileProvider><TaskChat taskId="perf-task" /></ProfileProvider></BrowserRouter>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
