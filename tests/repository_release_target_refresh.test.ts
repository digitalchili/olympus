import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectCpService } from '../server/project-cp.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';
import { insertTask, getTask } from '../server/db/queries.js';
import { createTaskAgentRun, finishTaskAgentRun } from '../server/db/task-agent-runs.js';
import { putQueuedTaskMessage, consumeQueuedTaskMessage } from '../server/db/task-message-queue.js';
import { captureCodingBaseline, verifyCodingRun } from '../server/coding-verification.js';
import { createRepositoryDevelopment } from '../server/repository-development.js';
import db from '../server/db/index.js';

const root = process.env.OLYMPUS_DISPATCH_HOME!, checkouts = join(root, 'checkouts'), seed = join(root, 'seed'), remote = join(root, 'remote.git');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
await mkdir(seed); await mkdir(checkouts); git(seed, 'init', '-b','main'); git(seed,'config','user.name','Fixture'); git(seed,'config','user.email','fixture@example.invalid');
await mkdir(join(seed, '.olympus')); await writeFile(join(seed,'.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }));
await writeFile(join(seed,'base.txt'),'base'); git(seed,'add','.'); git(seed,'commit','-m','Seed'); git(root,'clone','--bare',seed,remote);
upsertGitHubInstallation({ id: 66, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Release fixture', purpose: 'Check release scope', managerProfileId: 'default', changedBy: 'test' });
const link = upsertProjectRepositoryLink(project.id,66,{ id: 606, name:'fixture',fullName:'fixture/repo',owner:'fixture',private:true,defaultBranch:'main',htmlUrl:'https://example.invalid/repo',cloneUrl:remote });
const cp = createProjectCpService({ rootDir: checkouts }), development = createRepositoryDevelopment(checkouts);
async function start(title: string) {
  const task = insertTask({ title, status:'in_progress', project_id:project.id });
  const lease = await cp.prepareTask({ projectId: project.id, taskId:task.id,profileId:'default',repositoryLink:link,automaticHandoff:true });
  createTaskAgentRun({ taskId:task.id,runId:`run-${title}`,kind:'chat',status:'streaming',startedAt:Date.now() });
  await captureCodingBaseline(getTask(task.id)!,`run-${title}`);
  return { task, lease, runId:`run-${title}` };
}
async function finish(item: Awaited<ReturnType<typeof start>>, name: string) {
  await writeFile(join(item.lease.workdir,name),name); await development.checkpoint(item.lease);
  assert.equal(await verifyCodingRun(getTask(item.task.id)!,item.runId),true);
  finishTaskAgentRun(item.runId,'done'); return development.accept(getTask(item.task.id)!,item.runId,item.lease,link);
}

const { createRepositoryReleaseService } = await import('../server/repository-releases.js');
const { getRepositoryRelease } = await import('../server/db/repository-releases.js');
const service=createRepositoryReleaseService({rootDir:checkouts,cp});

const a=await start('Published A'); const sha=await finish(a,'a.txt');
const preview=await service.preview(project.id,'ready');await service.request(project.id,'ready',preview.token);await service.tick();
assert.equal((await service.overview(project.id)).changes.length,0);
git(seed,'fetch',remote,'main');git(seed,'merge','--ff-only','FETCH_HEAD');await writeFile(join(seed,'other.txt'),'external');git(seed,'add','.');git(seed,'commit','-m','External change');git(seed,'push',remote,'main');
const beforeHead=git(a.lease.workdir,'rev-parse','HEAD'), beforeIndex=await readFile(join(a.lease.workdir,'.git/index'));
const view=await service.overview(project.id);
assert.equal(view.changes.some(row=>row.state==='ready'),false,'unknown target ancestry cannot advertise already published work as ready');
await service.tick();
assert.equal((await service.overview(project.id)).changes.length,0,'background target refresh proves already published work is included');
assert.equal(git(a.lease.workdir,'rev-parse','HEAD'),beforeHead);assert.deepEqual(await readFile(join(a.lease.workdir,'.git/index')),beforeIndex);
const b=await start('New unpublished B');await finish(b,'b.txt');
assert.ok((await service.overview(project.id)).changes.some(row=>row.taskId===b.task.id&&row.state==='ready'),'fresh unpublished work remains ready');
console.log('External target advancement is reconciled without changing task checkouts');
