// Run against response-performance-server.ts --ui directly and via the test Nginx.
import assert from 'node:assert/strict';
const rows = [];
async function firstEvents(response, until) {
  let buffer = '';
  const events = [];
  for await (const chunk of response.body) {
    buffer += new TextDecoder().decode(chunk);
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data) continue;
      const event = JSON.parse(data);
      events.push({ event, receivedAt: performance.now() });
      if (until(event)) return events;
    }
  }
  throw new Error('SSE closed before terminal event');
}
for (const base of process.argv.slice(2)) {
  for (let sample = 0; sample < 3; sample++) {
    const created = await fetch(`${base}/fixture/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"scenario":"plain"}' });
    const { taskId } = await created.json();
    const abort = new AbortController();
    const liveUrl = `${base}/api/tasks/${taskId}/live?profile=default`;
    const stream = await fetch(liveUrl, { signal: abort.signal });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    assert.ok(!stream.headers.get('content-encoding'), 'fixture is not accumulated by compression');
    const reading = firstEvents(stream, event => event.type === 'done');
    const started = performance.now();
    const accepted = await fetch(`${base}/api/tasks/${taskId}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":"Say the fixture answer."}' });
    assert.equal(accepted.status, 202);
    const events = await reading; abort.abort();
    const activity = events.find(row => row.event.type === 'thinking_delta');
    const deltas = events.filter(row => row.event.type === 'text_delta');
    const terminal = events.at(-1);
    assert.equal(deltas.map(row => row.event.content).join(''), 'FIRST_ANSWER FINAL_ANSWER');
    // An 800ms producer gap must remain observable; completion-buffered delivery fails.
    assert.ok(deltas[0].receivedAt - activity.receivedAt > 300);
    assert.ok(terminal.receivedAt - deltas[0].receivedAt > 300);
    const reconnectAbort = new AbortController();
    const reconnect = await fetch(liveUrl, { signal: reconnectAbort.signal });
    const snapshot = (await firstEvents(reconnect, event => event.type === 'snapshot')).at(-1).event;
    reconnectAbort.abort();
    assert.equal(snapshot.run.status, 'done');
    assert.equal(snapshot.run.messages.filter(message => message.role === 'assistant').at(-1).content, 'FIRST_ANSWER FINAL_ANSWER');
    const result = await (await fetch(`${base}/fixture/result/${taskId}`)).json();
    assert.equal(result.starts, 1, 'reconnect does not resend');
    assert.equal(result.taskStatus, 'in_review');
    rows.push({ base, sample, firstActivityMs: activity.receivedAt - started, firstAnswerMs: deltas[0].receivedAt - started,
      doneMs: terminal.receivedAt - started, exactDeltas: true, terminalRecovered: true, starts: result.starts });
  }
}
console.log(JSON.stringify(rows, null, 2));
