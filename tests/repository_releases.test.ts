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
const a = await start('A'), aSha = await finish(a,'a.txt'), b = await start('B');
await writeFile(join(b.lease.workdir,'b.txt'),'unfinished B');
const module = await import('../server/repository-releases.js').catch(() => null);
const service = module?.createRepositoryReleaseService({ rootDir:checkouts, cp });
const preview = await service?.preview(project.id,'ready');
assert.equal(preview?.included.some(row => row.taskId === a.task.id),true,'ready publication includes checked A');
assert.equal(preview?.excluded.some(row => row.taskId === b.task.id),true,'unfinished B is explicitly excluded');
const release = await service!.request(project.id,'ready',preview!.token);
await service!.tick();
assert.equal((await service!.overview(project.id)).release?.state,'confirmed');
assert.equal(git(remote,'rev-parse','main'),aSha,'publish only the exact checked source shown in the preview');
assert.equal(await readFile(join(b.lease.workdir,'b.txt'),'utf8'),'unfinished B','active work is untouched');

const c = insertTask({ title:'C queued',status:'in_progress',project_id:project.id });
const queued = { taskId:c.id,id:'request-c',content:'Implement C',settings:{},invitedProfileIds:[],collaborationScope:'discussion' as const,confirmPersistentCollaboration:false,createdAt:Date.now(),updatedAt:Date.now() };
putQueuedTaskMessage(queued);
const waitPreview = await service!.preview(project.id,'all');
assert.deepEqual(new Set(waitPreview.included.map(row=>row.taskId)),new Set([b.task.id,c.id]));
await service!.request(project.id,'all',waitPreview.token);
await service!.tick();
assert.equal((await service!.overview(project.id)).release?.state,'waiting');
const bSha = await finish(b,'b.txt');
const leaseC = await cp.prepareTask({projectId:project.id,taskId:c.id,profileId:'default',repositoryLink:link,automaticHandoff:true});
const consumed = consumeQueuedTaskMessage(c.id,'request-c')!;
createTaskAgentRun({taskId:c.id,runId:'run-C',kind:'chat',status:'streaming',startedAt:Date.now()});
const { bindRepositoryReleaseQueue, getRepositoryRelease, saveRepositoryRelease } = await import('../server/db/repository-releases.js');
bindRepositoryReleaseQueue(consumed,'run-C');
await captureCodingBaseline(getTask(c.id)!,'run-C');
await service!.tick(); assert.equal(git(remote,'rev-parse','main'),aSha,'wait-all cannot silently drop the queued member');
const cSha = await finish({task:c,lease:leaseC,runId:'run-C'},'c.txt');
const later = await start('Later'), laterSha = await finish(later,'later.txt');
await module!.createRepositoryReleaseService({rootDir:checkouts,cp}).tick();
assert.equal(git(remote,'rev-parse','main'),cSha,'restart publishes the bounded group, not later accepted work');
assert.notEqual(cSha,laterSha); assert.notEqual(bSha,aSha);
assert.equal(git(remote,'show',`${cSha}:a.txt`),'a.txt'); assert.equal(git(remote,'show',`${cSha}:c.txt`),'c.txt');
assert.ok((await service!.overview(project.id)).changes.some(row=>row.taskId===later.task.id),'later work remains visible for a future release');
// A crash after the publication receipt is confirmed but before the intent is
// updated must reconcile, not attempt to prepare another commit.
saveRepositoryRelease({...getRepositoryRelease(release.id)!,state:'publishing'});
await service!.retry(project.id,release.id);
assert.equal(getRepositoryRelease(release.id)!.state,'confirmed','confirmation reconciliation is idempotent even when GitHub advanced through another confirmed release');

const queuedTask = insertTask({title:'Queued scope',status:'in_progress',project_id:project.id});
const savedRequest = {...queued,taskId:queuedTask.id,id:'scope-request'};
putQueuedTaskMessage(savedRequest);
const heldPreview = await service!.preview(project.id,'all');
const held = await service!.request(project.id,'all',heldPreview.token);
putQueuedTaskMessage({...savedRequest,content:'A different request',updatedAt:Date.now()+1});
await service!.tick();
assert.equal(getRepositoryRelease(held.id)!.state,'blocked','editing a captured queued request requires review');
assert.equal(git(remote,'rev-parse','main'),cSha);
service!.cancel(project.id,held.id);
consumeQueuedTaskMessage(queuedTask.id,savedRequest.id);
await assert.rejects(service!.preview(project.id,'ready','unrelated-profile'),/not found/i);
let unreachable = false, pushCount = 0;
const uncertainCp = createProjectCpService({rootDir:checkouts,gitRunner:async(cwd,args,opts)=>{
  if (unreachable && args[0]==='ls-remote') throw new Error('Fixture transport unavailable');
  const stdout=execFileSync('git',args,{cwd,env:opts?.env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if (args[0]==='push') { pushCount++; unreachable=true; throw new Error('Fixture connection lost after push'); }
  return {stdout,stderr:''};
}});
const uncertain = module!.createRepositoryReleaseService({rootDir:checkouts,cp:uncertainCp});
const uncertainPreview=await uncertain.preview(project.id,'ready');
const receipt=await uncertain.request(project.id,'ready',uncertainPreview.token);
await uncertain.tick();
assert.equal(getRepositoryRelease(receipt.id)!.state,'publishing','unknown outcomes remain unconfirmed');
assert.equal(git(remote,'rev-parse','main'),laterSha);
const afterUnknown=await start('After unknown'),afterUnknownSha=await finish(afterUnknown,'after-unknown.txt');
unreachable=false;
await uncertain.retry(project.id,receipt.id); await uncertain.tick();
assert.equal(getRepositoryRelease(receipt.id)!.state,'confirmed');
assert.equal(pushCount,1,'reconciliation must not push or commit twice');
assert.equal(git(remote,'rev-parse','main'),laterSha,'later accepted work cannot enter an uncertain saved release');

const advancePreview=await service!.preview(project.id,'ready');
const advanced=await service!.request(project.id,'ready',advancePreview.token);
git(seed,'fetch',remote,'main'); git(seed,'merge','--ff-only','FETCH_HEAD');
await writeFile(join(seed,'upstream.txt'),'upstream'); git(seed,'add','.'); git(seed,'commit','-m','Another publisher');git(seed,'push',remote,'main');
const advancedHead=git(remote,'rev-parse','main');
await service!.tick(); assert.equal(getRepositoryRelease(advanced.id)!.state,'blocked','an advanced target requires a fresh preview');
assert.equal(git(remote,'rev-parse','main'),advancedHead); assert.notEqual(advancedHead,afterUnknownSha);
service!.cancel(project.id,advanced.id);
// A fresh preview can combine the accepted code with the now-current main.
const mergedPreview=await service!.preview(project.id,'ready');
const merged=await service!.request(project.id,'ready',mergedPreview.token);
await service!.tick();
assert.equal(getRepositoryRelease(merged.id)!.state,'confirmed');
assert.equal(git(remote,'show','main:upstream.txt'),'upstream');
assert.equal(git(remote,'show','main:after-unknown.txt'),'after-unknown.txt');
assert.equal((await service!.overview(project.id)).changes.some(row=>row.state==='ready'),false,
  'publishing a checked merge must remove its included changes from the sidebar immediately');

const stopped = await start('Stopped while release waits');
await writeFile(join(stopped.lease.workdir,'saved.txt'),'keep my work');
const stoppedPreview = await service!.preview(project.id,'all');
const stoppedRelease = await service!.request(project.id,'all',stoppedPreview.token);
finishTaskAgentRun(stopped.runId,'stopped');
await service!.tick();
assert.equal(getRepositoryRelease(stoppedRelease.id)!.state,'blocked','a stopped member needs a clear decision, not an endless wait');
assert.match(getRepositoryRelease(stoppedRelease.id)!.message,/Stopped while release waits/);
service!.cancel(project.id,stoppedRelease.id);
assert.equal(await readFile(join(stopped.lease.workdir,'saved.txt'),'utf8'),'keep my work');

const bad=await start('Combined check failure');
await writeFile(join(bad.lease.workdir,'.olympus/verification.json'),JSON.stringify({commands:[[process.execPath,'-e',"process.exit(process.cwd().includes('/releases/') ? 1 : 0)"]]}));
await finish(bad,'checked-in-task.txt');
const beforeFailure=git(remote,'rev-parse','main'), badPreview=await service!.preview(project.id,'ready');
const blocked=await service!.request(project.id,'ready',badPreview.token);
await service!.tick();
assert.equal(getRepositoryRelease(blocked.id)!.state,'blocked','the combined candidate must pass its own checks');
assert.equal(git(remote,'rev-parse','main'),beforeFailure);
assert.equal(await readFile(join(bad.lease.workdir,'checked-in-task.txt'),'utf8'),'checked-in-task.txt');
service!.cancel(project.id,blocked.id);
const fixed=await start('Fix required checks');
await writeFile(join(fixed.lease.workdir,'.olympus/verification.json'),JSON.stringify({commands:[[process.execPath,'-e','process.exit(0)']]}));
const fixedSha=await finish(fixed,'fixed-checks.txt');
const orphan=await start('Unverified legacy ancestor'); await finish(orphan,'unreviewed.txt');
db.prepare('DELETE FROM repository_contributions WHERE task_id=?').run(orphan.task.id);
db.prepare('DELETE FROM coding_evidence WHERE task_id=?').run(orphan.task.id);
const dependent=await start('Depends on missing provenance'); await finish(dependent,'dependent.txt');
const gapPreview=await service!.preview(project.id,'ready');
assert.ok(gapPreview.excluded.some(row=>row.taskId===orphan.task.id));
assert.ok(gapPreview.excluded.some(row=>row.taskId===dependent.task.id),'a dependent change cannot be shown as independently ready');
const gap=await service!.request(project.id,'ready',gapPreview.token);
await service!.tick();
assert.equal(getRepositoryRelease(gap.id)!.state,'confirmed','publish the ready version before the unverified dependency');
assert.equal(git(remote,'rev-parse','main'),fixedSha);
assert.throws(()=>git(remote,'show','main:unreviewed.txt'));
assert.throws(()=>git(remote,'show','main:dependent.txt'));
console.log('Repository release choices, queued handoff and bounded restart tests passed');
