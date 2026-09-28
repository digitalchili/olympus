import assert from 'node:assert/strict';
import { checkHermesMaintenance } from '../server/hermes-maintenance.js';
import { DrainController } from '../server/drain.js';
import { createDrainRouter } from '../server/drain-http.js';
import express from 'express';
let runs = 0;
let background = { available: true, work: [] as Array<{id: string; kind: 'process'; status: string}> };
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
