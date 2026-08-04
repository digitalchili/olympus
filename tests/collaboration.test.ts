import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    collectContributors,
    contributorSystemMessage,
    isPrivateCollaborationEvent,
    validateCollaborationInvites,
  } = await import('../server/collaboration.js');
  const registry = new LocalProfileRegistry(hermesHome, root);

  const validated = validateCollaborationInvites(['default', 'writer'], 'default', registry);
  assert.equal(validated.ownerInvited, true);
  assert.deepEqual(validated.participants.map((profile) => profile.id), ['writer']);
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
