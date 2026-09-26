import assert from 'node:assert/strict';
import express from 'express';
import { createAgentRouter } from '../server/routes/agent.js';

const calls: unknown[] = [];
const response = { status: { provider: 'openai-codex', state: 'unknown', checkedAt: null, credentialScope: 'unknown', code: null }, session: null };
const app = express(); app.use(express.json());
app.use('/api/agent', createAgentRouter({
  getDefaults: async () => ({ provider: null, model: null, baseUrl: null, apiMode: null, reasoningEffort: 'medium', showReasoning: true }),
  setDefaults: async () => { throw new Error('must not change defaults'); }, getModels: async () => ({}),
  manageOpenAIAuth: async (...args: unknown[]) => { calls.push(args); return response; },
}));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/openai-auth`;
try {
  let result = await fetch(base);
  assert.equal(result.status, 200, 'in-app auth status route must exist');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), response);
  assert.deepEqual(calls.pop(), [{ action: 'status' }, 'default', 'shared']);
  result = await fetch(`${base}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'profile' }) });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.pop(), [{ action: 'start' }, 'default', 'profile']);
  for (const body of [{ scope: 'invalid' }, { token: 'secret-sentinel' }, { scope: 'shared', action: 'commit' }]) {
    result = await fetch(`${base}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.status, 400);
  }
  result = await fetch(`${base}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 404, 'private credential-save operation is not an HTTP route');
  result = await fetch(`${base}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0, 'invalid requests must not reach a worker');
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
console.log('OpenAI authentication route tests passed');
