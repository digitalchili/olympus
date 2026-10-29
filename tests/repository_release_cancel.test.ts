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

const { getActiveOperationCount } = await import('../server/task-run-lifecycle.js');
const a=await start('Slow release check');
const marker=join(root,'check-pid');
await writeFile(join(a.lease.workdir,'.olympus/verification.json'),JSON.stringify({commands:[[process.execPath,'-e',`if(process.cwd().includes('/releases/')){require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},30000);}`]]}));
await finish(a,'a.txt');const before=git(remote,'rev-parse','main');
const preview=await service.preview(project.id,'ready'), release=await service.request(project.id,'ready',preview.token);
const tick=service.tick();
let pid=0;for(let i=0;i<300&&!pid;i++){pid=Number(await readFile(marker,'utf8').catch(()=>''));if(!pid)await new Promise(resolve=>setTimeout(resolve,20));}
assert.ok(pid,'release check started');
let countAfterCancel=-1, aliveAfterCancel=true;
try { await service.cancel(project.id,release.id);countAfterCancel=getActiveOperationCount();try{process.kill(pid,0);}catch{aliveAfterCancel=false;} }
finally { try{process.kill(-pid,'SIGKILL');}catch{} await tick; }
assert.equal(aliveAfterCancel,false,'Cancel must wait for its release check process to terminate');
assert.equal(countAfterCancel,0,'Cancel must release its maintenance claim before returning');
assert.equal(getRepositoryRelease(release.id)?.state,'cancelled');assert.equal(git(remote,'rev-parse','main'),before);
assert.equal(await readFile(join(a.lease.workdir,'a.txt'),'utf8'),'a.txt');
console.log('Cancelling a release terminates only its checks and releases maintenance ownership');
