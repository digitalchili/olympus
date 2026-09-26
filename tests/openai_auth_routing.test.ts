import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProfileAgentAdapter } from '../server/adapters/routing.js';
import { LocalProfileRegistry } from '../server/local-profiles.js';
import type { AgentAdapter } from '../server/adapters/types.js';
import type { OpenAIAuthWorkerRequest, OpenAIAuthResponse } from '../shared/openai-auth.js';

const home = process.env.HERMES_HOME!;
for (const name of ['writer', 'other', 'third']) {
  await mkdir(join(home, 'profiles', name), { recursive: true });
  await writeFile(join(home, 'profiles', name, 'profile.yaml'), `description: ${name}\n`);
}
const calls: string[] = [];
const resets = new Map<string, () => void>();
let active = 0;
let beforeCommit: (() => Promise<void>) | undefined;
let failGuard = false;
let failOwnerRelease = false;
let loseCommitReply = false;
const waiting: OpenAIAuthResponse = {
  status: { provider: 'openai-codex', state: 'unknown', checkedAt: null, credentialScope: 'unknown', code: null },
  session: { sessionId: 'attempt', state: 'waiting_for_idle', verificationUrl: null, userCode: null, expiresAt: 999999, pollIntervalMs: 3000, code: null },
};
const worker = (name: string) => ({
  async start() {},
  async chat() { calls.push(`${name}:chat`); return { text: name, sessionId: name }; },
  async getMessages() { return []; },
  onDelegationEvent() { return () => {}; },
  onDelegationReset(listener: () => void) { resets.set(name, listener); return () => { resets.delete(name); }; },
  async manageOpenAIAuthWorker(input: OpenAIAuthWorkerRequest) {
    calls.push(`${name}:${input.action}${input.action === 'guard' ? `:${input.enabled}` : ''}`);
    if (input.action === 'guard') {
      if (name === 'default' && !input.enabled && failOwnerRelease) throw new Error('owner release uncertain');
      if (name === 'writer' && input.enabled && failGuard) throw new Error('acknowledgement lost');
      return { guarded: input.enabled, activeRuns: name === 'writer' ? active : 0 };
    }
    if (input.action === 'commit') {
      if (loseCommitReply) throw new Error('commit acknowledgement lost');
      await beforeCommit?.();
      return { ...waiting, session: { ...waiting.session!, state: 'saved' } };
    }
    return structuredClone(waiting);
  },
}) as unknown as AgentAdapter;

const adapter = new ProfileAgentAdapter(worker('default'), {
  registry: new LocalProfileRegistry(home), createAdapter: (profile) => worker(profile.id), taskProfile: id => id,
});
assert.equal(typeof adapter.manageOpenAIAuth, 'function', 'shared auth routing must be implemented');
await adapter.chat('writer', 'fixture');
calls.length = 0;
await adapter.manageOpenAIAuth({ action: 'start' }, 'writer', 'shared');
assert.deepEqual(calls, ['default:start'], 'shared login must target root, not create a profile credential copy');
calls.length = 0;
await adapter.manageOpenAIAuth({ action: 'start' }, 'writer', 'profile');
assert.deepEqual(calls, ['writer:start'], 'explicit profile login stays local');

calls.length = 0; active = 1;
const deferred = await adapter.manageOpenAIAuth({ action: 'poll', sessionId: 'attempt' }, 'writer', 'shared');
assert.equal(deferred.session?.state, 'waiting_for_idle');
assert.ok(!calls.includes('default:commit'), 'active named work prevents shared credential replacement');
assert.ok(calls.includes('writer:guard:false') && calls.includes('default:guard:false'), 'busy check releases all admission guards');

calls.length = 0; active = 0;
beforeCommit = async () => {
  await assert.rejects(adapter.chat('other', 'must wait'), (e: unknown) => (e as { code?: string }).code === 'auth_busy');
  assert.deepEqual(await adapter.getMessages('writer', 'writer'), [], 'running workers must keep their read and stop controls');
};
const saved = await adapter.manageOpenAIAuth({ action: 'poll', sessionId: 'attempt' }, 'writer', 'shared');
assert.equal(saved.session?.state, 'saved');
assert.ok(calls.indexOf('writer:guard:true') < calls.indexOf('default:commit'));
assert.equal(calls.filter(call => call === 'default:commit').length, 1);
assert.ok(!calls.includes('writer:commit'), 'shared save must preserve explicit profile credentials');
assert.ok(calls.includes('writer:invalidate'));
assert.ok(calls.includes('default:guard:false') && calls.includes('writer:guard:false'));

calls.length = 0; failGuard = true; beforeCommit = undefined;
await assert.rejects(adapter.manageOpenAIAuth({ action: 'poll', sessionId: 'attempt' }, 'writer', 'shared'));
assert.ok(!calls.includes('default:commit'));
assert.ok(calls.includes('writer:guard:false'), 'an uncertain guard acknowledgement must still be released');
failGuard = false;
await adapter.chat('other', 'fixture');
calls.length = 0; loseCommitReply = true; failOwnerRelease = true;
await assert.rejects(adapter.manageOpenAIAuth({ action: 'poll', sessionId: 'attempt' }, 'writer', 'shared'));
assert.ok(!calls.includes('writer:guard:false'), 'peers stay fenced until the owner acknowledges that its save has stopped');
await assert.rejects(adapter.chat('third', 'must wait'), (e: unknown) => (e as { code?: string }).code === 'auth_busy');
calls.length = 0; failOwnerRelease = false; loseCommitReply = false;
await adapter.manageOpenAIAuth({ action: 'status' }, 'writer', 'shared');
assert.ok(calls.indexOf('default:guard:false') < calls.indexOf('writer:guard:false'));
await adapter.chat('third', 'fixture');
beforeCommit = async () => {
  resets.get('writer')?.();
  await assert.rejects(adapter.getMessages('writer', 'writer'), (e: unknown) => (e as { code?: string }).code === 'auth_busy',
    'a crashed named worker must not implicitly restart outside the shared save fence');
};
await adapter.manageOpenAIAuth({ action: 'poll', sessionId: 'attempt' }, 'writer', 'shared');
await adapter.getMessages('writer', 'writer');
beforeCommit = undefined;
resets.get('writer')?.();
const afterIdleExit = await adapter.manageOpenAIAuth({ action: 'poll', sessionId: 'attempt' }, 'writer', 'shared');
assert.equal(afterIdleExit.session?.state, 'saved', 'an idle worker exit must not leave sign-in waiting forever');
console.log('Shared OpenAI routing and save coordination tests passed');
