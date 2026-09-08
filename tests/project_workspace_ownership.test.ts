import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'olympus-workspace-ownership-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'test.db');
const lifecycle = await import('../server/task-run-lifecycle.js');
const { default: db } = await import('../server/db/index.js');
try {
  const first = lifecycle.claimTaskOperation('first', 'project');
  assert.ok(first);
  const second = lifecycle.claimTaskOperation('second', 'project');
  try {
    assert.ok(second, 'independent task workspaces can perform operations concurrently');
    assert.equal(lifecycle.claimTaskOperation('first', 'project'), null, 'the same task remains exclusive');
    const sync = lifecycle.claimProjectOperation('project');
    assert.ok(sync, 'baseline sync is independent of active task workspaces');
    sync();
    assert.equal(lifecycle.getActiveOperationCount(), 2);
  } finally { first(); second?.(); }
  const configure = lifecycle.claimProjectConfigurationOperation('project');
  assert.ok(configure);
  try {
    assert.equal(lifecycle.claimTaskOperation('third', 'project'), null, 'repository configuration cannot race workspace preparation');
    assert.equal(lifecycle.claimProjectOperation('project'), null, 'repository configuration cannot race baseline sync');
  } finally { configure(); }
  const task = lifecycle.claimTaskOperation('third', 'project');
  assert.ok(task);
  try { assert.equal(lifecycle.claimProjectConfigurationOperation('project'), null); }
  finally { task(); task(); }
  const workspace = join(root, 'shared-repo'); const alias = join(root, 'alias');
  await mkdir(workspace); await symlink(workspace, alias);
  const preparing = lifecycle.claimTaskOperation('preparing', 'project')!;
  try {
    assert.equal(lifecycle.claimPreparedTaskWorkspace('preparing', workspace), true);
    assert.equal(lifecycle.claimTaskOperation('alias-task', 'project', alias), null, 'symlinks cannot bypass physical workspace ownership');
  } finally { preparing(); }
  const { insertTask } = await import('../server/db/queries.js');
  const { startRun, discardRun } = await import('../server/live-chat.js');
  const live = insertTask({title:'Live shared folder',status:'in_progress',workdir:workspace});
  startRun(live.id, live.id, 'Working');
  try { assert.equal(lifecycle.claimTaskOperation('new-caller', null, alias), null, 'post-202 live work keeps the same physical workspace protected'); }
  finally { discardRun(live.id); }
  assert.equal(lifecycle.getActiveOperationCount(), 0);
  console.log('Independent workspace ownership tests passed');
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
