import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-cp-model-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'project-cp.db');

try {
  const {
    acquireProjectEditor,
    getActiveProjectEditorForProfile,
    getActiveProjectEditorForTask,
    getProjectEditor,
    listProjectVersions,
    recordProjectVersion,
    releaseProjectEditor,
  } = await import('../server/db/project-cp.js');
  const { createProject } = await import('../server/db/projects.js');
  const { deleteTask, insertTask } = await import('../server/db/queries.js');
  const { default: db } = await import('../server/db/index.js');

  const project = createProject({
    name: 'Commit Push Fixture',
    purpose: 'Verify one editor and visible version history',
    managerProfileId: 'default',
    changedBy: 'local-user',
  }, 1_000);
  const firstTask = insertTask({
    title: 'Editable task',
    description: 'This task should become the Project editor',
    status: 'in_progress',
    project_id: project.id,
    handling_profile_id: 'default',
  });
  const secondTask = insertTask({
    title: 'Plan-only task',
    description: 'This task must not become a concurrent editor',
    status: 'in_progress',
    project_id: project.id,
    handling_profile_id: 'default',
  });

  const lease = acquireProjectEditor({
    projectId: project.id,
    taskId: firstTask.id,
    profileId: 'default',
    repositoryFullName: 'example/atlas',
    baseBranch: 'main',
    workdir: join(root, 'managed', project.id),
    branchName: 'olympus/project-abc',
    baseSha: 'a'.repeat(40),
    leaseToken: 'lease-token-1',
    now: 2_000,
  });

  assert.equal(lease.taskId, firstTask.id);
  assert.equal(lease.status, 'active');
  assert.equal(lease.releasedAt, null);
  assert.equal(getProjectEditor(project.id)?.taskId, firstTask.id);
  assert.equal(getActiveProjectEditorForTask(firstTask.id)?.projectId, project.id);
  assert.equal(getActiveProjectEditorForProfile('default')?.taskId, firstTask.id);

  assert.throws(
    () => acquireProjectEditor({
      projectId: project.id,
      taskId: secondTask.id,
      profileId: 'default',
      repositoryFullName: 'example/atlas',
      baseBranch: 'main',
      workdir: join(root, 'managed', project.id, 'second'),
      branchName: 'olympus/project-second',
      baseSha: 'b'.repeat(40),
      leaseToken: 'lease-token-2',
      now: 2_100,
    }),
    /already has an editor/i,
  );

  const commit = recordProjectVersion({
    projectId: project.id,
    taskId: firstTask.id,
    leaseId: lease.id,
    action: 'commit_push',
    commitSha: 'c'.repeat(40),
    parentSha: 'a'.repeat(40),
    branchName: 'olympus/project-abc',
    commitMessage: 'Update Project content',
    changedFiles: ['README.md', 'src/index.ts'],
    pushedAt: 3_000,
  });
  assert.equal(commit.action, 'commit_push');
  assert.deepEqual(commit.changedFiles, ['README.md', 'src/index.ts']);

  const revert = recordProjectVersion({
    projectId: project.id,
    taskId: firstTask.id,
    leaseId: lease.id,
    action: 'revert',
    commitSha: 'd'.repeat(40),
    parentSha: 'c'.repeat(40),
    revertedVersionId: commit.id,
    branchName: 'olympus/project-abc',
    commitMessage: 'Revert Update Project content',
    changedFiles: ['README.md'],
    pushedAt: 4_000,
  });

  assert.deepEqual(listProjectVersions(project.id).map((entry) => ({
    action: entry.action,
    commitSha: entry.commitSha,
    revertedVersionId: entry.revertedVersionId,
    changedFiles: entry.changedFiles,
  })), [
    { action: 'revert', commitSha: 'd'.repeat(40), revertedVersionId: commit.id, changedFiles: ['README.md'] },
    { action: 'commit_push', commitSha: 'c'.repeat(40), revertedVersionId: null, changedFiles: ['README.md', 'src/index.ts'] },
  ]);

  deleteTask(firstTask.id);
  const historyAfterTaskDeletion = listProjectVersions(project.id);
  assert.equal(historyAfterTaskDeletion.length, 2, 'version history survives editor task deletion');
  assert.equal(historyAfterTaskDeletion[0]?.taskId, null, 'deleted task attribution becomes unavailable without deleting history');

  releaseProjectEditor({ leaseId: lease.id, taskId: firstTask.id, now: 5_000 });
  assert.equal(getProjectEditor(project.id), null);

  const afterRelease = acquireProjectEditor({
    projectId: project.id,
    taskId: secondTask.id,
    profileId: 'default',
    repositoryFullName: 'example/atlas',
    baseBranch: 'main',
    workdir: join(root, 'managed', project.id, 'second'),
    branchName: 'olympus/project-second',
    baseSha: 'd'.repeat(40),
    leaseToken: 'lease-token-2',
    now: 5_100,
  });
  assert.equal(afterRelease.taskId, secondTask.id);

  const storedSecrets = JSON.stringify(db.prepare('SELECT * FROM project_editor_leases').all())
    + JSON.stringify(db.prepare('SELECT * FROM project_versions').all());
  assert.equal(storedSecrets.includes('ghs_'), false, 'Project CP tables must not persist GitHub tokens');

  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project CP model tests passed');
