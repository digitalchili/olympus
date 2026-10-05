import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { InboxItem, InboxPreview } from '../shared/inbox.js';
import { inboxTaskUrl } from '../shared/inbox.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-inbox-'));
const hermesHome = join(root, 'hermes');
for (const name of ['', 'profiles/writer', 'profiles/inactive']) {
  await mkdir(join(hermesHome, name), { recursive: true });
  await writeFile(join(hermesHome, name, 'config.yaml'), '{}\n');
  await writeFile(join(hermesHome, name, 'profile.yaml'), `displayName: ${name ? name.split('/')[1] : 'Somboon'}\nactive: ${!name.includes('inactive')}\n`);
}
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'dispatch');
process.env.DB_PATH = join(root, 'inbox.db');
const [queries, live, runs, interactions, projects, { beginRecovery }, { claimTaskOperation }, { createInboxRouter }, { default: db }] = await Promise.all([
  import('../server/db/queries.js'), import('../server/live-chat.js'), import('../server/db/task-agent-runs.js'),
  import('../server/db/interactions.js'), import('../server/db/projects.js'), import('../server/run-recovery.js'),
  import('../server/task-run-lifecycle.js'), import('../server/routes/inbox.js'), import('../server/db/index.js'),
]);
let historyReads = 0;
let duringHistory: (() => void) | undefined;
const app = express();
app.use('/api/inbox', createInboxRouter({
  async getMessagePage(sessionId, taskId) {
    historyReads++;
    assert.equal(sessionId, taskId);
    duringHistory?.();
    return { messages: [{ id: 'reply', task_id: taskId, role: 'assistant', content: 'Saved result', created_at: Date.now() }], pageInfo: { hasOlder: false, olderCursor: null } };
  },
}));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/inbox`;
const list = async () => (await (await fetch(base)).json() as { items: InboxItem[] }).items;
const preview = (item: InboxItem) => fetch(`${base}/${item.taskId}?key=${encodeURIComponent(item.key)}`);
const task = (title: string, profile = 'default', status: 'in_review' | 'in_progress' | 'done' = 'in_progress', projectId?: string) =>
  queries.insertTask({ title, profile_name: profile, handling_profile_id: profile, status, project_id: projectId });
function finish(taskId: string, status: 'error' | 'stopped' | 'done' = 'error') {
  const runId = `run-${taskId}`;
  runs.createTaskAgentRun({ taskId, runId, status: 'streaming', kind: 'chat', startedAt: Date.now() - 1000 });
  runs.finishTaskAgentRun(runId, status);
  return runId;
}
function question(taskId: string, profileName: string, runId: string, id: string, expiresAt = 0) {
  interactions.recordInteraction({ taskId, profileName, olympusRunId: runId, interaction: {
    id, workerRunId: `worker-${id}`, kind: 'clarification', title: 'Choose a design', expiresAt,
    questions: [{ id: 'design', question: 'Which design?', choices: ['A', 'B'], multiSelect: false }],
  } });
}
try {
  const review = task('Review result', 'writer', 'in_review');
  // Viewed results still need review; reading the Inbox must not complete or mark them read.
  queries.updateTask(review.id, { last_agent_response_at: 100 });
  queries.markTaskViewed(review.id);
  assert.equal(queries.getTask(review.id)?.last_viewed_at, 100);
  task('Done', 'default', 'done');
  task('Inactive', 'inactive', 'in_review');
  queries.insertTask({ title: 'Bot', kind: 'bot', status: 'in_review' });
  const healthy = task('Healthy');
  live.startRun(healthy.id, healthy.id, 'work');
  const failed = task('Failed');
  const failedRun = finish(failed.id);
  const stopped = task('Stopped'); finish(stopped.id, 'stopped');
  const incomplete = task('Incomplete'); finish(incomplete.id, 'done');
  const recovering = task('Recovering');
  const recoveryRun = finish(recovering.id);
  beginRecovery(recovering.id, recoveryRun, Date.now());
  db.prepare("UPDATE task_recovery SET state = 'pending' WHERE task_id = ?").run(recovering.id);
  const waiting = task('Waiting', 'writer');
  live.startRun(waiting.id, waiting.id, 'work');
  const waitingRun = live.getRunStatus(waiting.id)!.runId;
  question(waiting.id, 'writer', waitingRun, 'question');
  question(waiting.id, 'writer', waitingRun, 'second-question');
  const expired = task('Expired'); live.startRun(expired.id, expired.id, 'work');
  question(expired.id, 'default', live.getRunStatus(expired.id)!.runId, 'expired', Date.now() - 1);
  question(healthy.id, 'default', 'old-run', 'stale');
  question(healthy.id, 'writer', live.getRunStatus(healthy.id)!.runId, 'wrong-profile');
  const project = projects.createProject({ name: 'Private project', purpose: 'Inbox access test', managerProfileId: 'default', changedBy: 'test' });
  const restricted = task('Restricted', 'writer', 'in_review', project.id);
  const allowed = task('Allowed', 'default', 'in_review', project.id);
  const items = await list();
  assert.deepEqual(items.map(i => i.taskId).sort(), [review, failed, stopped, incomplete, waiting, allowed].map(t => t.id).sort());
  assert.equal(items.find(i => i.taskId === waiting.id)?.category, 'questions');
  assert.equal(items.find(i => i.taskId === failed.id)?.category, 'help');
  assert.equal(items.find(i => i.taskId === review.id)?.category, 'review');
  assert.equal(items.find(i => i.taskId === review.id)?.profileId, 'writer');
  assert.equal(historyReads, 0, 'listing never loads histories or starts workers');
  assert.equal(interactions.getInteraction('expired')?.status, 'waiting', 'read-only projection does not mutate expired rows');
  const waitingPreview = await (await preview(items.find(i => i.taskId === waiting.id)!)).json() as InboxPreview;
  assert.equal(waitingPreview.interaction?.questions[0].question, 'Which design?');
  assert.equal(historyReads, 0, 'questions are previewed without history');
  const before = queries.getTask(review.id);
  const reviewItem = items.find(i => i.taskId === review.id)!;
  const reply = await (await preview(reviewItem)).json() as InboxPreview;
  assert.equal(reply.reply?.content, 'Saved result');
  assert.equal(inboxTaskUrl(reviewItem), `/tasks/${review.id}?profile=writer`);
  assert.equal(inboxTaskUrl(items.find(i => i.taskId === allowed.id)!), `/projects/${project.id}/tasks/${allowed.id}?profile=default`);
  assert.deepEqual(queries.getTask(review.id), before, 'preview never marks read or completes a task');
  assert.equal((await fetch(`${base}/${restricted.id}?key=guessed`)).status, 404);
  interactions.markInteractionSettled('question', 'answered');
  interactions.markInteractionSettled('second-question', 'answered');
  assert.equal((await preview(items.find(i => i.taskId === waiting.id)!)).status, 409, 'settled questions cannot be previewed as waiting');
  assert.ok(!(await list()).some(i => i.taskId === waiting.id));
  live.startRun(failed.id, failed.id, 'retry');
  assert.ok(!(await list()).some(i => i.taskId === failed.id), 'a new live run supersedes the old failure');
  live.discardRun(failed.id);
  beginRecovery(failed.id, failedRun, Date.now());
  db.prepare("UPDATE task_recovery SET state = 'waiting' WHERE task_id = ?").run(failed.id);
  assert.ok(!(await list()).some(i => i.taskId === failed.id));
  question(failed.id, 'default', failedRun, 'interrupted-question');
  interactions.markInteractionSettled('interrupted-question', 'cancelled');
  assert.equal((await list()).find(i => i.taskId === failed.id)?.category, 'help', 'cancelled question blocks native recovery and needs human attention');
  interactions.markInteractionSettled('interrupted-question', 'answered');
  const { putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
  putQueuedTaskMessage({ taskId: recovering.id, id: 'followup', content: 'Saved follow-up', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: Date.now(), updatedAt: Date.now() });
  assert.equal((await list()).find(i => i.taskId === recovering.id)?.category, 'help', 'queued input pauses error recovery and must stay visible');
  const release = claimTaskOperation(review.id)!;
  assert.ok(!(await list()).some(i => i.taskId === review.id), 'admission in progress suppresses stale review');
  release();
  duringHistory = () => queries.updateTask(review.id, { status: 'done' });
  assert.equal((await preview(reviewItem)).status, 409, 'terminal transition during history read invalidates preview');
  duringHistory = undefined;
  projects.grantProjectProfileAccess({ projectId: project.id, profileId: 'writer', role: 'view', grantedBy: 'test' });
  const grantedItem = (await list()).find(i => i.taskId === restricted.id)!;
  assert.ok(grantedItem);
  duringHistory = () => projects.revokeProjectProfileAccess(project.id, 'writer');
  assert.equal((await preview(grantedItem)).status, 404, 'revocation during history read cannot expose history');
  duringHistory = undefined;
  const approvalTask = task('Approval');
  live.startRun(approvalTask.id, approvalTask.id, 'work');
  interactions.recordInteraction({ taskId: approvalTask.id, profileName: 'default', olympusRunId: live.getRunStatus(approvalTask.id)!.runId, interaction: {
    id: 'approval', workerRunId: 'approval-worker', kind: 'approval', title: 'Permission needed', questions: [], command: 'example command', reason: 'Approval required', expiresAt: 0,
  } });
  const approvalItem = (await list()).find(i => i.taskId === approvalTask.id)!;
  assert.equal(approvalItem.actionLabel, 'Review request');
  assert.equal((await (await preview(approvalItem)).json() as InboxPreview).interaction?.command, 'example command');
  assert.equal(interactions.getInteraction('approval')?.status, 'waiting', 'preview never approves a command');
  const { beginProfileDeletion } = await import('../server/profile-deletion.js');
  const deletion = beginProfileDeletion('default');
  assert.ok(!(await list()).some(i => i.profileId === 'default'), 'deleting profiles are excluded');
  assert.equal((await preview(approvalItem)).status, 404);
  deletion.release();
  interactions.claimInteraction({ taskId: approvalTask.id, profileName: 'default', interactionId: 'approval', workerRunId: 'approval-worker', olympusRunId: live.getRunStatus(approvalTask.id)!.runId, response: { decision: 'once' } });
  assert.ok(!(await list()).some(i => i.taskId === approvalTask.id), 'delivery in progress is not a new approval');
  interactions.markInteractionDeliveryUnknown('approval', 'DO_NOT_EXPOSE_PRIVATE_WORKER_ERROR');
  const unknownItem = (await list()).find(i => i.taskId === approvalTask.id)!;
  assert.equal(unknownItem.category, 'help');
  assert.doesNotMatch(JSON.stringify(await (await preview(unknownItem)).json()), /DO_NOT_EXPOSE_PRIVATE_WORKER_ERROR|Review request/);
  duringHistory = () => { throw new Error('private worker error'); };
  const unavailable = await (await preview(unknownItem)).json() as InboxPreview;
  assert.equal(unavailable.historyUnavailable, true);
  assert.doesNotMatch(JSON.stringify(unavailable), /private worker error/);
  const { localProfileRegistry } = await import('../server/local-profiles.js');
  const discoverProfiles = localProfileRegistry.publicProfiles;
  try {
    localProfileRegistry.publicProfiles = () => { throw new Error('private filesystem error'); };
    assert.equal((await fetch(base)).status, 503);
    const response = await preview(unknownItem);
    assert.equal(response.status, 503, 'preview discovery failures are handled without an unhandled rejection');
    assert.doesNotMatch(await response.text(), /private filesystem error/);
  } finally { localProfileRegistry.publicProfiles = discoverProfiles; }
  console.log('Inbox routes: classification, resolution, read-only previews, profile and Project boundaries passed');
} finally {
  for (const t of queries.getAllTasks()) live.discardRun(t.id);
  server.close(); await once(server, 'close'); db.close(); await rm(root, { recursive: true, force: true });
}
