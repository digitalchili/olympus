import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import express from 'express';
import type { HermesRuntimeInfo } from '../shared/hermes-updates.js';
import { parseHermesCompatibility, createHermesUpdateService, latestHermesTarget, hermesUpdateHook } from '../server/hermes-updates.js';
import { createHermesUpdatesRouter } from '../server/routes/hermes-updates.js';

const target = { schemaVersion: 1, version: '2026.9.24', revision: 'f97608f178d1ffeca59860195ab7da295f7c8e5f', image: 'nousresearch/hermes-agent:v2026.9.24@sha256:' + 'a'.repeat(64), releaseUrl: 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24' };
assert.deepEqual(parseHermesCompatibility(target), target);
for (const invalid of [null, { ...target, revision: 'main' }, { ...target, image: 'evil/image:latest' }, { ...target, releaseUrl: 'javascript:alert(1)' }, { ...target, version: '../bad' }]) {
  assert.throws(() => parseHermesCompatibility(invalid));
}
const bundled = parseHermesCompatibility(JSON.parse(await readFile('hermes-runtime.json', 'utf8')));
assert.ok((await readFile('Dockerfile', 'utf8')).includes(`ARG HERMES_IMAGE=${bundled.image}`), 'build and compatibility target must agree');
let current: HermesRuntimeInfo = { available: true, version: '2026.9.1', revision: 'b'.repeat(40), installation: 'source', sourcePath: '/selected/hermes', pythonPath: '/selected/hermes/venv/bin/python', dirty: false };
let configured = true;
let method = 'native';
let operation: unknown = null;
let applied = 0;
let latestFails = false;
const service = createHermesUpdateService({
  runtime: async () => current,
  version: () => '0.7.24',
  localTarget: () => bundled,
  latestTarget: async () => { if (latestFails) throw new Error('SECRET'); return { target: bundled, olympusVersion: '0.7.25' }; },
  hook: async (verb, body) => {
    if (verb === 'GET') return { method, configured, operation };
    assert.equal(body?.target.revision, bundled.revision);
    applied += 1;
    return { accepted: true, operationId: 'receipt-1' };
  },
});
const app = express(); app.use(express.json()); app.use('/api/updates/hermes', createHermesUpdatesRouter(service));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/api/updates/hermes`;
const status = async () => (await fetch(url)).json();
const apply = (body = { targetRevision: bundled.revision, targetOlympusVersion: '0.7.24' }, headers = {}) => fetch(`${url}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Olympus-Update': '1', ...headers }, body: JSON.stringify(body) });
try {
  assert.equal((await status()).canApply, true);
  assert.equal((await apply()).status, 202);
  assert.equal(applied, 1);
  assert.equal((await apply({ targetRevision: 'a'.repeat(40), targetOlympusVersion: '0.7.24' })).status, 409);
  assert.equal((await apply(undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  current = { ...current, dirty: true }; assert.equal((await status()).canApply, false);
  assert.equal((await apply()).status, 409);
  current = { ...current, dirty: false, revision: bundled.revision }; assert.equal((await status()).updateAvailable, false);
  current = { ...current, revision: null }; assert.equal((await status()).canApply, false);
  current = { ...current, revision: 'b'.repeat(40), installation: 'docker' }; method = 'native'; assert.equal((await status()).canApply, false);
  method = 'dokploy'; assert.equal((await status()).canApply, true);
  assert.equal((await status()).targetOlympusVersion, '0.7.25');
  latestFails = true; const unavailable = await status(); assert.equal(unavailable.canApply, false); assert.ok(unavailable.error); assert.doesNotMatch(JSON.stringify(unavailable), /SECRET/);
  latestFails = false; configured = false; assert.equal((await status()).canApply, false);
  configured = true; operation = { id: 'one', phase: 'installing', targetRevision: bundled.revision, targetVersion: bundled.version, startedAt: 1, updatedAt: 2, message: 'Installing.' };
  assert.equal((await status()).canApply, false);
  assert.equal((await apply()).status, 409);
  operation = { ...operation as object, phase: 'interrupted' }; assert.equal((await status()).canApply, false);
  configured = false; assert.match((await status()).reason, /interrupted/);
  operation = { ...operation as object, targetRevision: '', targetVersion: '' };
  assert.equal((await status()).operation.phase, 'interrupted');
  assert.match((await status()).reason, /interrupted/);
  assert.equal(applied, 1, 'invalid, stale, blocked and cross-site requests never reach updater');
} finally { server.close(); }

const originalFetch = globalThis.fetch;
let calls = 0;
let release: any = { tag_name: 'v0.7.25', draft: false, prerelease: false, published_at: '2026-09-28T00:00:00Z' };
let missingManifest = false;
globalThis.fetch = async input => {
  calls++;
  if (String(input).endsWith('/releases/latest')) return Response.json(release);
  assert.equal(String(input), 'https://raw.githubusercontent.com/digitalchili/olympus/v0.7.25/hermes-runtime.json');
  return Response.json(missingManifest ? {} : bundled, { status: missingManifest ? 404 : 200 });
};
try {
  assert.equal((await latestHermesTarget(true)).olympusVersion, '0.7.25');
  await latestHermesTarget(); assert.equal(calls, 2, 'normal polling reuses release metadata');
  await latestHermesTarget(true); assert.equal(calls, 4, 'confirmation refreshes release authority');
  const valid = release;
  for (const invalid of [{ ...valid, draft: true }, { ...valid, prerelease: true }, { ...valid, published_at: null }, { ...valid, tag_name: 'main' }, { ...valid, tag_name: 'v999999999999999999999.1.1' }]) {
    release = invalid; await assert.rejects(latestHermesTarget(true));
  }
  release = valid; missingManifest = true; await assert.rejects(latestHermesTarget(true));
  await assert.rejects(latestHermesTarget(), 'a failed refresh must not expose an earlier successful check as current');
} finally { globalThis.fetch = originalFetch; }

const directory = await mkdtemp('/tmp/olympus-hermes-socket-');
const socket = `${directory}/update.sock`;
const before = { socket: process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET, token: process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN };
let rejectHook = false;
const localHook = createServer((req, res) => {
  assert.equal(req.url, '/hermes');
  assert.equal(req.headers.authorization, 'Bearer fixture-only-token');
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (rejectHook) { res.writeHead(503); res.end('private upstream details'); return; }
    if (req.method === 'POST') { assert.equal(JSON.parse(body).target.revision, bundled.revision); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { accepted: true, operationId: 'socket-receipt' } : { method: 'native', configured: true, operation: null }));
  });
});
await new Promise<void>((resolve, reject) => { localHook.once('error', reject); localHook.listen(socket, resolve); });
try {
  process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = socket;
  process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN = 'fixture-only-token';
  assert.equal((await hermesUpdateHook('GET')).configured, true);
  assert.equal((await hermesUpdateHook('POST', { repository: 'digitalchili/olympus', olympusVersion: '0.7.24', target: bundled })).operationId, 'socket-receipt');
  rejectHook = true;
  await assert.rejects(hermesUpdateHook('GET'), error => error instanceof Error && !error.message.includes('private'));
} finally {
  await new Promise<void>(resolve => localHook.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  if (before.socket === undefined) delete process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET; else process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = before.socket;
  if (before.token === undefined) delete process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN; else process.env.OLYMPUS_DISPATCH_UPDATE_TOKEN = before.token;
}
console.log('Hermes compatibility and update admission tests passed');
