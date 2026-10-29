import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const home=process.env.HERMES_HOME!;
await mkdir(join(home,'profiles','unrelated'),{recursive:true});
await writeFile(join(home,'profiles/unrelated/profile.yaml'),'displayName: Unrelated\nactive: true\n');
await writeFile(join(home,'config.yaml'),'{}');await writeFile(join(home,'profiles/unrelated/config.yaml'),'{}');
const { createProjectsRouter }=await import('../server/routes/projects.js');
const { createProject, upsertProjectRepositoryLink }=await import('../server/db/projects.js');
const { upsertGitHubInstallation }=await import('../server/db/studio-projects.js');
const project=createProject({name:'Release routes',purpose:'Scope and access',managerProfileId:'default',changedBy:'test'});
upsertGitHubInstallation({id:99,accountLogin:'fixture',accountType:'Organization',permissionMode:'read_write'});
upsertProjectRepositoryLink(project.id,99,{id:990,name:'fixture',fullName:'fixture/repo',owner:'fixture',private:true,defaultBranch:'main',htmlUrl:'https://example.invalid/repo',cloneUrl:'https://example.invalid/repo.git'});
const calls:any[]=[];
const service={overview:async(...args:any[])=>{calls.push(['overview',...args]);return {changes:[]};},preview:async(...args:any[])=>{calls.push(['preview',...args]);return {token:'exact-preview'};},request:async(...args:any[])=>{calls.push(['request',...args]);return {id:'saved'};},retry:async(...args:any[])=>calls.push(['retry',...args]),cancel:(...args:any[])=>calls.push(['cancel',...args])};
const app=express();app.use(express.json());app.use('/api/projects',createProjectsRouter({repositoryReleases:service as never}));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
const call=(path:string,method='GET',body?:unknown,profile='default')=>fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/${path}?profile=${profile}`,{method,headers:{'Content-Type':'application/json'},...(body && method !== 'GET'?{body:JSON.stringify(body)}:{})});
try {
  assert.equal((await call('repository-changes')).status,200);
  assert.deepEqual(calls.pop(),['overview',project.id,'default']);
  assert.equal((await call('repository-releases/preview','POST',{mode:'ready'})).status,200);
  assert.deepEqual(calls.pop(),['preview',project.id,'ready','default']);
  assert.equal((await call('repository-releases','POST',{mode:'ready',token:'exact-preview'})).status,202);
  assert.deepEqual(calls.pop(),['request',project.id,'ready','exact-preview','default']);
  for(const action of ['retry','cancel']) { assert.equal((await call(`repository-releases/saved/${action}`,'POST')).status,202);assert.deepEqual(calls.pop(),[action,project.id,'saved','default']); }
  for(const [path,method] of [['repository-changes','GET'],['repository-releases/preview','POST'],['repository-releases','POST'],['repository-releases/saved/retry','POST'],['repository-releases/saved/cancel','POST']]) assert.equal((await call(path,method,{mode:'all'},'unrelated')).status,404);
  assert.equal(calls.length,0,'denied requests cannot reach the publication service');
} finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
console.log('Repository release routes preserve caller scope and reject inaccessible Projects');
