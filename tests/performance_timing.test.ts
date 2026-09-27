import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPerformanceTrace, requestPerformanceTrace } from '../server/performance-timing.js';
import { buildChatWorkerRequest } from '../server/adapters/hermes-worker.js';

let now = 0;
const lines: string[] = [];
const options = { clock: () => now, write: (line: string) => lines.push(line) };
delete process.env.OLYMPUS_PERF_DIAGNOSTICS;
assert.equal(createPerformanceTrace(options), null);
assert.deepEqual(lines, []);
process.env.OLYMPUS_PERF_DIAGNOSTICS = '1';
const trace = createPerformanceTrace(options)!;
await trace.span('inventory', async () => { now = 40; return { token: 'SECRET', message: 'PRIVATE', path: '/private/fixture' }; });
trace.bindRun('00000000-0000-4000-8000-000000000001');
trace.mark('accepted');
await trace.span('baseline', async () => { now = 120; });
now = 150; trace.mark('first_text');
now = 180; trace.mark('first_text');
trace.finish('rejected'); // HTTP close must not finish an accepted background run.
assert.equal(lines.filter(line => JSON.parse(line.slice(15)).event === 'finished').length, 0);
trace.finish('done'); trace.finish('error'); trace.finish('stopped');
const records = lines.map(line => JSON.parse(line.slice(15)));
assert.equal(records.find(record => record.stage === 'inventory').durationMs, 40);
assert.equal(records.find(record => record.stage === 'baseline').durationMs, 80);
assert.equal(records.find(record => record.stage === 'first_text').elapsedMs, 150);
assert.equal(records.filter(record => record.stage === 'first_text').length, 1);
assert.equal(records.filter(record => record.event === 'finished').length, 1);
assert.ok(!JSON.stringify(records).includes('SECRET') && !JSON.stringify(records).includes('/private'));
assert.ok(!records.some(record => record.stage === 'verification'), 'missing stages remain absent');
assert.equal(buildChatWorkerRequest('task', 'PRIVATE', { timingTraceId: trace.id }).timingTraceId, trace.id);
assert.doesNotThrow(() => { const broken = createPerformanceTrace({ ...options, write: () => { throw Error('sink'); } })!; broken.mark('first_text'); broken.finish('error'); });
const rejected = new EventEmitter() as EventEmitter & { locals: Record<string, unknown> };
rejected.locals = {};
const original = console.error;
const requestLines: string[] = [];
console.error = (line: string) => requestLines.push(line);
try {
  requestPerformanceTrace(rejected);
  rejected.emit('finish'); rejected.emit('close');
  assert.equal(requestLines.length, 1);
  assert.equal(JSON.parse(requestLines[0].slice(15)).outcome, 'rejected');
  assert.equal(JSON.parse(requestLines[0].slice(15)).runId, undefined);
} finally { console.error = original; delete process.env.OLYMPUS_PERF_DIAGNOSTICS; }
console.log('Performance deterministic baseline: inventory=40ms baseline=80ms first_text=150ms; privacy/idempotence passed');

// Exercise the real admission/202/background settlement path with fake provider I/O.
const { once } = await import('node:events');
const { mkdir, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');
await mkdir(process.env.HERMES_HOME!, { recursive: true });
await writeFile(join(process.env.HERMES_HOME!, 'config.yaml'), '{}\n');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
const logs: string[] = [];
const captured: string[] = [];
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.chatStream = async function* (sessionId, _message, options) {
  captured.push(options?.timingTraceId ?? 'missing');
  await gate;
  yield { type: 'thinking_delta', content: 'PRIVATE reasoning' };
  yield { type: 'text_delta', content: '' };
  yield { type: 'text_delta', content: 'PRIVATE answer' };
  yield { type: 'text_delta', content: ' more' };
  yield { type: 'done', sessionId };
};
console.error = (line: string) => { if (String(line).startsWith('[olympus-perf] ')) logs.push(line); };
process.env.OLYMPUS_PERF_DIAGNOSTICS = '1';
try {
  const task = insertTask({ title: 'PRIVATE', status: 'in_progress', profile_name: 'default' });
  const response = await fetch(`${base}/${task.id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'PRIVATE input', timingTraceId: 'SECRET' }) });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  let rows = logs.map(line => JSON.parse(line.slice(15)));
  assert.ok(rows.some(row => row.stage === 'inventory'));
  assert.ok(rows.some(row => row.stage === 'accepted' && row.runId === accepted.runId));
  assert.ok(!rows.some(row => row.event === 'finished'), '202 must not finish the background trace');
  release();
  for (let i = 0; i < 200 && !logs.some(line => line.includes('"event":"finished"')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  rows = logs.map(line => JSON.parse(line.slice(15)));
  assert.equal(getLatestTaskAgentRun(task.id)?.status, 'done');
  assert.equal(rows.filter(row => row.event === 'finished').length, 1);
  assert.equal(rows.find(row => row.event === 'finished').outcome, 'done');
  for (const stage of ['baseline', 'adapter_dispatch', 'first_activity', 'first_text', 'native_done', 'verification', 'artifacts']) assert.equal(rows.filter(row => row.stage === stage).length, 1, stage);
  assert.deepEqual(captured, [rows[0].traceId]);
  assert.doesNotMatch(logs.join(''), /PRIVATE|SECRET/);
  adapter.getBackgroundWork = async () => ({ available: false, work: [] });
  const rejectedResponse = await fetch(`${base}/${task.id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":"PRIVATE"}' });
  assert.equal(rejectedResponse.status, 503);
  const rejectedRow = logs.map(line => JSON.parse(line.slice(15))).find(row => row.outcome === 'rejected');
  assert.ok(rejectedRow); assert.equal(rejectedRow.runId, undefined);
} finally {
  release(); console.error = original; delete process.env.OLYMPUS_PERF_DIAGNOSTICS;
  server.close(); await once(server, 'close'); db.close();
}
console.log('Performance real admission/rejection and background settlement tests passed');
