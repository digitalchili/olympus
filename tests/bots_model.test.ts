import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-bots-model-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'state', 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const queries = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');
const profiles = [
  { id: 'default', label: 'Main Bot', workspaceDir: join(root, 'default-workspace'), isDefault: true },
  { id: 'writer', label: 'Writer', workspaceDir: join(root, 'writer-workspace') },
];

try {
  await test('new ordinary tasks retain their kind and reject unsupported kinds', () => {
    const task = queries.insertTask({ title: 'Board task', status: 'in_progress' });
    assert.equal(task.kind, 'task');
    assert.throws(() => queries.insertTask({ title: 'Invalid', status: 'in_progress', kind: 'unknown' } as never), /CHECK|kind/);
  });

  await test('each profile has one permanent Bot chat with independent workspace and identity', async () => {
    const { ensureBotTask, getBotTask } = await import('../server/db/bots.js');
    const primary = ensureBotTask(profiles[0]);
    const writer = ensureBotTask(profiles[1]);
    assert.equal(primary.kind, 'bot');
    assert.equal(primary.handling_profile_id, 'default');
    assert.equal(primary.profile_name, 'default');
    assert.equal(primary.workdir, profiles[0].workspaceDir);
    assert.equal(primary.title, 'Main Bot');
    assert.equal(primary.status, 'in_progress');
    assert.notEqual(writer.id, primary.id);
    assert.equal(getBotTask('writer')?.id, writer.id);
    assert.equal(getBotTask('missing'), undefined);
    assert.equal(ensureBotTask(profiles[0]).id, primary.id, 'opening the chat does not replace its session');
    assert.throws(() => queries.insertTask({ title: 'Duplicate', kind: 'bot', status: 'in_progress', handling_profile_id: 'writer' }), /UNIQUE/);
  });

  await test('boards and attention exclude Bots while profile deletion and recovery can include them', async () => {
    const { ensureBotTask } = await import('../server/db/bots.js');
    const { createProject } = await import('../server/db/projects.js');
    const project = createProject({ name: 'Board project', purpose: 'Filter bots', managerProfileId: 'default', changedBy: 'test' });
    const bot = ensureBotTask(profiles[1]);
    const task = queries.insertTask({ title: 'Review task', status: 'in_review', handling_profile_id: 'writer', project_id: project.id, last_agent_response_at: 10 });
    // Even stale or externally altered Bot rows must stay outside board projections.
    db.prepare('UPDATE tasks SET status=?, project_id=?, last_agent_response_at=? WHERE id=?').run('in_review', project.id, 10, bot.id);
    assert.deepEqual(queries.getTasksForProfile('writer', false).map(row => row.id), [task.id]);
    assert.deepEqual(queries.getTasksForProfile('writer', false, 'in_review').map(row => row.id), [task.id]);
    assert.deepEqual(queries.getTasksForProject(project.id).map(row => row.id), [task.id]);
    assert.equal(queries.getAllTasks().some(row => row.kind === 'bot'), false);
    assert.equal(queries.getAllTasks(undefined, true).some(row => row.id === bot.id), true);
    assert.deepEqual(queries.getProfileTaskAttention(), [{ profileId: 'writer', reviewCount: 1 }]);
    assert.equal(queries.getTasksForProfile('writer', false, undefined, true).some(row => row.id === bot.id), true);
    const deleted = queries.deleteTasksForProfile('writer');
    assert.deepEqual(new Set(deleted), new Set([task.id, bot.id]));
    assert.equal(queries.getTask(bot.id), undefined);
    assert.ok(queries.getTask(ensureBotTask(profiles[0]).id), 'other profiles remain untouched');
  });

  await test('generic data mutations preserve Bot identity and allow chat settings and viewed state', async () => {
    const { ensureBotTask } = await import('../server/db/bots.js');
    const bot = ensureBotTask(profiles[0]);
    for (const fields of [{ kind: 'task' }, { status: 'done' }, { handling_profile_id: 'writer' }, { profile_name: 'writer' }, { project_id: 'elsewhere' }, { workdir: '/elsewhere' }]) {
      assert.throws(() => queries.updateTask(bot.id, fields as never), /permanent|Bot/i);
    }
    assert.equal(queries.deleteTask(bot.id), false);
    assert.equal(queries.updateTask(bot.id, { title: 'My Bot', agent_model: 'configured-model' })?.agent_model, 'configured-model');
    queries.recordAgentResponse(bot.id, 42);
    assert.equal(queries.markTaskViewed(bot.id).task?.last_viewed_at, 42);
    assert.equal(queries.getTask(bot.id)?.status, 'in_progress');
    const task = queries.insertTask({ title: 'Ordinary', status: 'in_progress' });
    assert.throws(() => queries.updateTask(task.id, { kind: 'bot' } as never), /kind|permanent|Bot/i);
  });
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
