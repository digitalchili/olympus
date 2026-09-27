import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChat } from '../../client/src/hooks/useChat';

type Sample = { index: number; start: number; accepted?: number; activity?: number; received?: number; committed?: number; terminal?: number; firstTextWhileStreaming?: boolean; text?: string; error?: string };
let active: Sample | undefined;
const NativeEventSource = window.EventSource;
window.EventSource = class extends NativeEventSource {
  constructor(url: string | URL, options?: EventSourceInit) {
    super(url, options);
    this.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (!active) return;
      const ms = performance.now() - active.start;
      if (['thinking_delta', 'text_delta'].includes(data.type) && data.content) active.activity ??= ms;
      if (data.type === 'text_delta' && data.content) active.received ??= ms;
    });
  }
};

function Fixture() {
  const chat = useChat();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Sample[]>([]);
  const completion = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const answer = chat.messages.filter(message => message.role === 'assistant').at(-1)?.content;
    if (answer?.startsWith('FIRST_ANSWER') && active.committed === undefined) {
      active.committed = performance.now() - active.start;
      active.firstTextWhileStreaming = chat.isStreaming;
    }
    if (!chat.isStreaming && answer === 'FIRST_ANSWER FINAL_ANSWER' && completion.current) {
      active.terminal = performance.now() - active.start;
      active.text = answer;
      const resolve = completion.current; completion.current = null; resolve();
    }
  }, [chat.messages, chat.isStreaming]);
  const run = async (count: number) => {
    setRunning(true); setResults([]);
    const rows: Sample[] = [];
    try {
      for (let index = -2; index < count; index++) {
        const { taskId } = await (await fetch('/fixture/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"scenario":"plain"}' })).json();
        await chat.loadMessages(taskId);
        active = { index, start: performance.now() };
        const done = new Promise<void>(resolve => { completion.current = resolve; });
        const sent = await chat.sendMessage(taskId, 'Say the fixture answer.');
        active.accepted = performance.now() - active.start;
        if (!sent.ok) throw new Error('Fixture Send failed');
        await done;
        rows.push({ ...active }); setResults([...rows]); active = undefined;
        await new Promise(requestAnimationFrame);
      }
    } catch (error) { rows.push({ index: rows.length, start: 0, error: String(error) }); setResults([...rows]); }
    finally { active = undefined; setRunning(false); }
  };
  const warm = results.filter(row => row.index >= 0 && row.committed !== undefined);
  const percentile = (values: number[], fraction: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  return <main style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '24px auto' }}>
    <h1>Response performance fixture</h1>
    <p>Real HTTP/SSE and chat hook; fake agent; temporary data only. Render means React committed DOM, not a browser paint timestamp.</p>
    <button disabled={running} onClick={() => void run(1)}>Run one sample</button>{' '}
    <button disabled={running} onClick={() => void run(30)}>Run 30 warm samples</button>
    <p role="status">{running ? 'Benchmark running' : 'Benchmark idle'} · {warm.length} warm samples · task {chat.isStreaming ? 'running' : 'settled'}</p>
    <section aria-label="Chat">{chat.messages.map(message => <p key={message.id}>{message.content || message.thinking}</p>)}</section>
    <pre data-testid="summary">{JSON.stringify({ samples: warm.length,
      receiveToCommitMedian: percentile(warm.map(row => row.committed! - row.received!), .5),
      receiveToCommitP95: percentile(warm.map(row => row.committed! - row.received!), .95),
      firstTextWhileStreaming: warm.every(row => row.firstTextWhileStreaming), failures: results.filter(row => row.error).length }, null, 2)}</pre>
    <details><summary>Raw fixture measurements</summary><pre data-testid="results">{JSON.stringify(results, null, 2)}</pre></details>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
