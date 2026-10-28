import assert from 'node:assert/strict';
import { checkHermesMaintenance } from '../server/hermes-maintenance.js';
import { DrainController } from '../server/drain.js';
import { createDrainRouter } from '../server/drain-http.js';
import express from 'express';
import type { TaskBackgroundWork } from '../shared/background-work.js';
let runs = 0;
let background: TaskBackgroundWork = { available: true, work: [] };
let verified = false;
const controller = new DrainController(() => runs);
const runtime = { available: true, revision: 'a'.repeat(40), version: '2026.9.24', installation: 'source' as const, sourcePath: '/hermes', pythonPath: '/hermes/venv/bin/python', dirty: false };
const adapter = { getBackgroundWork: async () => background, getHermesRuntime: async (verify?: boolean) => { verified = verify === true; return runtime; } };
assert.equal((await checkHermesMaintenance(controller, adapter, ['done-task'])).ready, false);
controller.begin(); runs = 1;
assert.equal((await checkHermesMaintenance(controller, adapter, ['done-task'])).ready, false);
runs = 0; background.available = false;
assert.equal((await checkHermesMaintenance(controller, adapter, ['done-task'])).ready, false);
background.available = true; background.work = [{ id: 'preview', kind: 'process', status: 'running' }];
assert.equal((await checkHermesMaintenance(controller, adapter, ['done-task'])).ready, false);
background.work = [];
assert.equal((await checkHermesMaintenance(controller, adapter, ['done-task'])).ready, true);
assert.equal(verified, true, 'real import verification, not just bridge health');

background = { available: true, work: [],
  continuation: { status: 'blocked', reason: 'Stopped by user or interaction; explicit continuation is required.' },
  checkpoint: { saved: true, source: 'task-continuation-journal', pendingDelegationIds: [], undeliveredResultCount: 0 } };
const savedStop = structuredClone(background);
let stopped = true;
const checkStopped = () => checkHermesMaintenance(controller, adapter, ['stopped-task'], () => stopped);
assert.equal((await checkStopped()).ready, true, 'an explicitly stopped idle task must not prevent maintenance');
assert.deepEqual(background, savedStop, 'maintenance must retain the stop marker and saved journal');
stopped = false;
assert.equal((await checkStopped()).ready, false, 'an interaction or unknown blocked turn is not an explicit stop');
stopped = true;
background.work = [{ id: 'child', kind: 'delegation', status: 'running' }];
assert.equal((await checkStopped()).ready, false, 'a stopped parent cannot authorize interrupting a child');
background = structuredClone(savedStop); background.available = false;
assert.equal((await checkStopped()).ready, false, 'an unknown inventory still blocks maintenance');
background = structuredClone(savedStop); delete background.checkpoint;
assert.equal((await checkStopped()).ready, false, 'an unverified stop marker is insufficient');
background = structuredClone(savedStop); background.checkpoint!.saved = false;
assert.equal((await checkStopped()).ready, false, 'an unsaved journal cannot authorize maintenance');
background = structuredClone(savedStop); background.checkpoint!.source = 'unknown';
assert.equal((await checkStopped()).ready, false, 'only the durable continuation journal proves an idle stop');
background = structuredClone(savedStop); background.continuation!.reason = 'Prior model turn did not finish';
assert.equal((await checkStopped()).ready, false, 'an ambiguous interrupted turn must remain blocked');
background = structuredClone(savedStop); background.checkpoint!.pendingDelegationIds = ['undelivered-child'];
assert.equal((await checkStopped()).ready, false, 'saved child results still require reconciliation');
background = structuredClone(savedStop); background.checkpoint!.undeliveredResultCount = 1;
assert.equal((await checkStopped()).ready, false, 'undelivered results must remain guarded');
background = structuredClone(savedStop); background.continuation = { status: 'pending' };
assert.equal((await checkStopped()).ready, false, 'pending recovery is not an idle stop');
for (const malformed of [
  { ...savedStop, checkpoint: { ...savedStop.checkpoint, pendingDelegationIds: '' } },
  { ...savedStop, checkpoint: { ...savedStop.checkpoint, saved: 'true' } },
  { ...savedStop, available: 'true' },
  { ...savedStop, work: '' },
]) {
  background = JSON.parse(JSON.stringify(malformed));
  assert.equal((await checkStopped()).ready, false, 'malformed worker inventory must fail closed');
}
background = { available: true, work: [] };

let fenced = true;
const app = express();
app.use('/api/maintenance', createDrainRouter(controller, 'fixture-token', undefined, {
  check: () => checkHermesMaintenance(controller, adapter, ['done-task']), fenced: () => fenced,
}));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/api/maintenance`;
try {
  assert.equal((await fetch(`${url}/hermes/check`)).status, 401, 'runtime maintenance needs the installation token');
  const headers = { Authorization: 'Bearer fixture-token' };
  assert.equal((await (await fetch(`${url}/hermes/check`, { headers })).json()).ready, true);
  assert.equal((await fetch(`${url}/cancel`, { headers, method: 'POST' })).status, 409);
  assert.equal(controller.status().draining, true, 'a browser cannot clear the durable update fence');
  fenced = false;
  assert.equal((await fetch(`${url}/cancel`, { headers, method: 'POST' })).status, 200);
  assert.equal(controller.status().ready, true);
} finally { server.close(); }
console.log('Hermes maintenance checks passed');
