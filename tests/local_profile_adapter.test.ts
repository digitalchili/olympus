import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProfileRegistry } from '../server/local-profiles.js';
import { ProfileAgentAdapter } from '../server/adapters/routing.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from '../server/adapters/types.js';

function fakeAdapter(name: string, lifecycle: string[]): AgentAdapter & { start(): Promise<void>; stop(): Promise<void> } {
  return {
    async start() { lifecycle.push(`start:${name}`); },
    async stop() { lifecycle.push(`stop:${name}`); },
    async chat() { return { text: name, sessionId: name }; },
    async *chatStream(): AsyncIterable<StreamEvent> { yield { type: 'done', sessionId: name }; },
    async interruptChat() { return true; },
    async steerChat() { return true; },
    async healthCheck() { return true; },
    async getMessages(_sessionId, taskId) {
      return [{ id: name, task_id: taskId, role: 'assistant', content: name, created_at: 1 }];
    },
    async getSessionMetadata() { return null; },
    async generateTitle() { return { title: name }; },
    async compressSession(sessionId) { return { compressed: false, sessionId, previousMessageCount: 0, compressedMessageCount: 0 }; },
    async getGoalStatus() { return null; },
    async setGoal(_sessionId, goal) { return { goal, status: 'active', turnsUsed: 0, maxTurns: 1 }; },
    async pauseGoal() { return null; },
    async resumeGoal() { return null; },
    async clearGoal() { return true; },
    async evaluateGoal() { return { status: null, shouldContinue: false, verdict: 'inactive', reason: name, message: name }; },
    async listScheduledTasks() { return []; },
    async getScheduledTask() { return null; },
    async createScheduledTask() { throw new Error('not used'); },
    async updateScheduledTask() { return null; },
    async pauseScheduledTask() { return null; },
    async resumeScheduledTask() { return null; },
    async runScheduledTask() { return null; },
    async removeScheduledTask() { return true; },
    async tickScheduledTasks() { return 0; },
  };
}

const hermesHome = join(process.cwd(), `.test-profile-adapter-${process.pid}`);
const lifecycle: string[] = [];

try {
  await mkdir(join(hermesHome, 'profiles', 'writer'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'writer', 'profile.yaml'), 'description: Writer\n');

  const created: Array<{ id: string; hermesHome: string }> = [];
  const taskProfiles = new Map<string, string | null>([
    ['default-task', null],
    ['writer-task', 'writer'],
    ['missing-task', 'not-local'],
  ]);
  const adapter = new ProfileAgentAdapter(fakeAdapter('default', lifecycle), {
    registry: new LocalProfileRegistry(hermesHome),
    createAdapter(profile) {
      created.push({ id: profile.id, hermesHome: profile.hermesHome });
      return fakeAdapter(profile.id, lifecycle);
    },
    taskProfile(taskId) {
      return taskProfiles.get(taskId) ?? null;
    },
  });

  await adapter.start();
  assert.deepEqual(lifecycle, ['start:default']);
  assert.deepEqual(created, [], 'named profile workers must be lazy');

  assert.equal((await adapter.chat('default-task', 'hello')).text, 'default');
  assert.equal((await adapter.chat('writer-task', 'hello')).text, 'writer');
  assert.equal((await adapter.chat('writer-task', 'again')).text, 'writer');
  assert.deepEqual(created, [{ id: 'writer', hermesHome: join(hermesHome, 'profiles', 'writer') }]);

  const streamOptions: AgentRunOptions = { task: { id: 'writer-task', title: 'Writer task' } };
  const events: StreamEvent[] = [];
  for await (const event of adapter.chatStream('writer-task', 'stream', streamOptions)) events.push(event);
  assert.deepEqual(events, [{ type: 'done', sessionId: 'writer' }]);
  assert.equal((await adapter.getMessages('writer-task', 'writer-task'))[0]?.content, 'writer');

  await assert.rejects(() => adapter.chat('missing-task', 'hello'), /unknown local Hermes profile/i);
  assert.equal(created.length, 1);

  await adapter.stop();
  assert.deepEqual(lifecycle, ['start:default', 'start:writer', 'stop:default', 'stop:writer']);
} finally {
  await rm(hermesHome, { recursive: true, force: true });
}

console.log('Local profile execution routing tests passed');
