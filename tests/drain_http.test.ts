import assert from 'node:assert/strict';
import { DrainController } from '../server/drain.js';
import { createDrainRouter, isMaintenanceAuthorized, maintenanceGuard } from '../server/drain-http.js';

const controller = new DrainController(() => 0);
assert.equal(isMaintenanceAuthorized(undefined, 'test-secret'), false);
assert.equal(isMaintenanceAuthorized('Bearer wrong', 'test-secret'), false);
assert.equal(isMaintenanceAuthorized('Bearer test-secret', undefined), false);
assert.equal(isMaintenanceAuthorized('Bearer test-secret', 'test-secret'), true);

async function invoke(method: string) {
  const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown, next: false };
  const req = { method };
  const res = {
    setHeader(name: string, value: string) { result.headers[name.toLowerCase()] = value; },
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  maintenanceGuard(controller)(req as never, res as never, () => { result.next = true; });
  return result;
}

assert.equal((await invoke('POST')).next, true);
controller.begin();
assert.equal(controller.status().ready, false);
const rejected = await invoke('POST');
assert.equal(rejected.status, 503);
assert.equal(rejected.headers['retry-after'], '5');
assert.equal((rejected.body as { code: string }).code, 'MAINTENANCE_DRAIN');
assert.equal((await invoke('GET')).next, true);
controller.cancel();
assert.equal((await invoke('POST')).next, true);

let activeRuns = 1;
let idleCallbacks = 0;
const deferredController = new DrainController(() => activeRuns);
const router = createDrainRouter(deferredController, 'test-secret', () => { idleCallbacks += 1; });
const drainHandler = (router.stack.find((layer) => layer.route?.path === '/drain')?.route.stack[0].handle) as Function;
const cancelHandler = (router.stack.find((layer) => layer.route?.path === '/cancel')?.route.stack[0].handle) as Function;
const response = { json() { return this; } };
drainHandler({}, response);
cancelHandler({}, response);
activeRuns = 0;
deferredController.notifyRunChange();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(idleCallbacks, 0, 'cancelled drain must cancel the deferred idle callback');
console.log('Drain HTTP tests passed');
