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
const { createRepositoryQueue } = await import('../server/repository-queue.js');
const { bindRepositoryReleaseQueue, listRepositoryContributions } = await import('../server/db/repository-releases.js');
const { recordRepositoryRun } = await import('../server/db/repository-queue.js');
const queue = createRepositoryQueue({rootDir:checkouts,adapter:{async getBackgroundWork(){return {available:true,work:[],continuation:{status:'none'}};}}});
const a=await start('active-and-queued'); await queue.admit(getTask(a.task.id)!);
const queued={taskId:a.task.id,id:'follow-up',content:'Implement B after A',settings:{},invitedProfileIds:[],collaborationScope:'discussion' as const,confirmPersistentCollaboration:false,createdAt:Date.now(),updatedAt:Date.now()};
putQueuedTaskMessage(queued);
const preview=await service.preview(project.id,'all'); const release=await service.request(project.id,'all',preview.token);
await writeFile(join(a.lease.workdir,'a.txt'),'A'); await development.checkpoint(a.lease); await verifyCodingRun(getTask(a.task.id)!,a.runId); finishTaskAgentRun(a.runId,'done');
await queue.tick();
assert.equal(listRepositoryContributions('github:606').length,0);
const consumed=consumeQueuedTaskMessage(a.task.id,'follow-up')!; createTaskAgentRun({taskId:a.task.id,runId:'second',kind:'chat',status:'streaming',startedAt:Date.now()}); recordRepositoryRun(a.task.id,'second'); bindRepositoryReleaseQueue(consumed,'second');
await captureCodingBaseline(getTask(a.task.id)!,'second'); await writeFile(join(a.lease.workdir,'b.txt'),'B'); await development.checkpoint(a.lease); await verifyCodingRun(getTask(a.task.id)!,'second');finishTaskAgentRun('second','done'); await queue.tick();
await service.tick();
assert.equal(getRepositoryRelease(release.id)?.state,'confirmed','the final checked queued run covers its captured active turn');
assert.equal(git(remote,'show','main:a.txt'),'A');assert.equal(git(remote,'show','main:b.txt'),'B');
console.log('Same-task captured follow-up publishes both checked changes');
