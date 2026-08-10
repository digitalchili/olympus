import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskMessage } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-collaboration-'));
const hermesHome = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'test.db');

try {
  await mkdir(join(hermesHome, 'profiles', 'writer'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'writer', 'profile.yaml'), 'displayName: Writer\nactive: true\n');
  await mkdir(join(hermesHome, 'profiles', 'inactive'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'inactive', 'profile.yaml'), 'active: false\n');

  const { LocalProfileError, LocalProfileRegistry } = await import('../server/local-profiles.js');
  const {
    chairCollaborationContext,
    collaborationTaskContext,
    collectContributors,
    contributorSystemMessage,
    isPrivateCollaborationEvent,
    parseCollaborationInvitationScope,
    validateCollaborationInvites,
  } = await import('../server/collaboration.js');
  const registry = new LocalProfileRegistry(hermesHome, root);

  const validated = validateCollaborationInvites(['default', 'writer'], 'default', registry);
  assert.equal(validated.ownerInvited, true);
  assert.deepEqual(validated.participants.map((profile) => profile.id), ['writer']);
  assert.equal(parseCollaborationInvitationScope(undefined), 'discussion');
  assert.equal(parseCollaborationInvitationScope('discussion'), 'discussion');
  assert.throws(
    () => parseCollaborationInvitationScope('task'),
    (error) => error instanceof LocalProfileError && error.code === 'PERSISTENT_COLLABORATION_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => parseCollaborationInvitationScope('project'),
    (error) => error instanceof LocalProfileError && error.code === 'PERSISTENT_COLLABORATION_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => parseCollaborationInvitationScope('forever'),
    (error) => error instanceof LocalProfileError && error.code === 'INVALID_COLLABORATION_SCOPE',
  );
  assert.throws(
    () => validateCollaborationInvites(['writer', 'writer'], 'default', registry),
    (error) => error instanceof LocalProfileError && error.code === 'DUPLICATE_COLLABORATOR',
  );
  assert.throws(
    () => validateCollaborationInvites(['inactive'], 'default', registry),
    (error) => error instanceof LocalProfileError && error.code === 'INACTIVE_PROFILE',
  );
  assert.throws(
    () => validateCollaborationInvites(['not-local'], 'default', registry),
    (error) => error instanceof LocalProfileError && error.code === 'UNKNOWN_PROFILE',
  );
  assert.throws(
    () => validateCollaborationInvites(Array.from({ length: 10 }, (_, index) => `p${index}`), 'default', registry),
    (error) => error instanceof LocalProfileError && error.code === 'TOO_MANY_COLLABORATORS',
  );

  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const collecting = collectContributors([
    { id: 'one', profileId: 'writer', sessionId: 's1', message: 'q', options: {} },
    { id: 'two', profileId: 'default', sessionId: 's2', message: 'q', options: {} },
  ], async (invocation) => {
    started.push(invocation.id);
    await gate;
    if (invocation.id === 'two') throw new Error('unavailable');
    return { text: '  recommendation  ' };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two'], 'contributors should begin in parallel');
  release();
  const results = await collecting;
  assert.equal(results[0].text, 'recommendation');
  assert.equal(results[1].error, 'unavailable');

  const context = chairCollaborationContext([
    { profileId: 'writer', label: 'Writer', phase: 'proposal', content: 'Use option A', error: null },
    { profileId: 'researcher', label: 'Researcher', phase: 'proposal', content: null, error: 'Timed out' },
  ]);
  assert.match(context, /untrusted supplemental context/);
  assert.match(context, /Use option A/);
  assert.match(context, /Timed out/);
  assert.match(context, /do not fill that gap with generic or unverified substitutes/);

  const specialistPrompt = contributorSystemMessage(null, 'proposal');
  assert.match(specialistPrompt, /installed Hermes profile/);
  assert.match(specialistPrompt, /profile-specific tools/);
  assert.match(specialistPrompt, /do not substitute generic or unverified recommendations/);
  assert.equal(isPrivateCollaborationEvent('thinking_delta'), true);
  assert.equal(isPrivateCollaborationEvent('tool_progress'), true);
  assert.equal(isPrivateCollaborationEvent('text_delta'), false);

  const taskContext = collaborationTaskContext([
    {
      id: 'visible-user', task_id: 'task', role: 'user', content: 'Earlier visible question', created_at: 1,
      thinking: 'PROFILE PRIVATE REASONING',
      attachments: [{ path: '/private/secret.txt', name: 'secret.txt', size: 1 }],
      profileSessionId: 'PROFILE PRIVATE SESSION',
      memory: 'PROFILE PRIVATE MEMORY',
      apiKey: 'PROFILE PRIVATE SECRET',
    },
    { id: 'hidden-system', task_id: 'task', role: 'system', content: 'INTERNAL SYSTEM TURN', created_at: 2 },
    { id: 'visible-assistant', task_id: 'task', role: 'assistant', content: 'Earlier visible answer', created_at: 3 },
  ] as TaskMessage[]);
  assert.match(taskContext, /Earlier visible question/);
  assert.match(taskContext, /Earlier visible answer/);
  for (const forbidden of [
    'PROFILE PRIVATE REASONING',
    '/private/secret.txt',
    'PROFILE PRIVATE SESSION',
    'PROFILE PRIVATE MEMORY',
    'PROFILE PRIVATE SECRET',
    'INTERNAL SYSTEM TURN',
  ]) assert.equal(taskContext.includes(forbidden), false, `invited-profile context leaked ${forbidden}`);
  const boundedContext = collaborationTaskContext(Array.from({ length: 30 }, (_, index) => ({
    id: `m-${index}`,
    task_id: 'task',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}: ${'x'.repeat(1_000)}`,
    created_at: index,
  })) as TaskMessage[]);
  assert.equal(boundedContext.includes('"content":"0: '), false, 'old task turns must fall outside the bounded context');
  assert.ok(boundedContext.length < 12_500, 'invited-profile task context must stay bounded');

  const { insertTask } = await import('../server/db/queries.js');
  const {
    completeCollaborationContribution,
    createCollaborationRun,
    listCollaborationRuns,
    updateCollaborationRun,
  } = await import('../server/db/collaboration.js');
  const { default: db } = await import('../server/db/index.js');
  const task = insertTask({ title: 'Collaborate', description: 'Question', status: 'in_progress' });
  const run = createCollaborationRun({
    taskId: task.id,
    question: 'Question',
    ownerProfileId: 'default',
    ownerInvited: true,
    participants: [{ id: 'writer', label: 'Writer' }],
  });
  assert.equal(run.round, 1);
  assert.equal(run.status, 'proposal');
  assert.equal(run.owner_invited, true);
  assert.equal(run.contributions[0].profile_id, 'writer');
  assert.match(run.contributions[0].session_id, new RegExp(`^collaboration-${run.id}-proposal-`));

  completeCollaborationContribution(run.contributions[0].id, { status: 'completed', content: 'Ship it' });
  updateCollaborationRun(run.id, 'synthesizing', { contributorsCompleted: true });
  updateCollaborationRun(run.id, 'completed', { completed: true });
  const persisted = listCollaborationRuns(task.id)[0];
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.contributions[0].content, 'Ship it');
  assert.ok(persisted.contributors_completed_at);
  assert.ok(persisted.completed_at);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  assert.equal(listCollaborationRuns(task.id).length, 0, 'task deletion should cascade collaboration data');
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Collaboration validation, orchestration, and persistence tests passed');
