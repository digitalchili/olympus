import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'task-start-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db.sqlite');
for (const id of ['default', 'som']) {
 const home = id === 'default' ? process.env.HERMES_HOME : join(process.env.HERMES_HOME, 'profiles', id);
 await mkdir(home, {recursive:true}); await writeFile(join(home,'config.yaml'),'{}');
 await writeFile(join(home,'profile.yaml'),`displayName: ${id}\nactive: true\n`);
}
const {default: app, adapter} = await import('../server/app.js');
const {default: db} = await import('../server/db/index.js');
const {getQueuedTaskMessage} = await import('../server/db/task-message-queue.js');
const {getTask} = await import('../server/db/queries.js');
const {getLatestTaskAgentRun} = await import('../server/db/task-agent-runs.js');
const {configureQueuedMessageDispatcher,createQueuedMessageDispatcher,assertQueuedMessageDeliveryResponse} = await import('../server/queued-message-dispatcher.js');
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/tasks`;
const deferred: Array<()=>void>=[];
let starts=0;
adapter.getBackgroundWork=async()=>({available:true,work:[]});
adapter.setGoal=async()=>({goal:'Replacement',status:'active',turnsUsed:0,maxTurns:20});
adapter.evaluateGoal=async()=>({status:'done',shouldContinue:false,verdict:'done',reason:'finished',message:''});
adapter.chatStream=async function*(sessionId, content){starts++;assert.equal(content,'Replacement for AU0080\n\n[file](/saved/wines.csv)');yield {type:'text_delta',content:'Found replacement.'};yield {type:'done',sessionId};};
const deliveryErrors: unknown[]=[];
const dispatcher=createQueuedMessageDispatcher({load:getQueuedTaskMessage,isActive:()=>false,defer:work=>deferred.push(work),onError:(_id,error)=>deliveryErrors.push(error),deliver:async(id,message)=>{
 const response=await fetch(`${base}/${id}/messages?profile=${getTask(id)!.profile_name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...message,queuedMessageId:message.id})});
 await assertQueuedMessageDeliveryResponse(response);
}});
configureQueuedMessageDispatcher(dispatcher);
const post=async(initialMessage:unknown)=>fetch(`${base}?profile=default`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Replacement wine',description:'Replacement for AU0080',handlingProfileId:'som',initialMessage})});
try {
 const response=await post({content:'Replacement for AU0080\n\n[file](/saved/wines.csv)',settings:{mode:'goal',model:'native-model',provider:'openai-codex',reasoningEffort:'low'},invitedProfileIds:[]});
 assert.equal(response.status,201);const {task}=await response.json();
 const saved=getQueuedTaskMessage(task.id);
 assert.ok(saved,'first request is durable before the creation response');
 assert.equal(saved.content,'Replacement for AU0080\n\n[file](/saved/wines.csv)');
 assert.equal(saved.settings.mode,'goal');assert.equal(saved.settings.model,'native-model');
 assert.equal(task.profile_name,'som');assert.equal(deferred.length,1);
 // No browser visits the task or submits a second request. Server queue dispatch starts it.
 deferred.shift()!();
 for(let i=0;i<100 && getLatestTaskAgentRun(task.id)?.status!=='done';i++) await new Promise(r=>setTimeout(r,10));
 assert.equal(getLatestTaskAgentRun(task.id)?.status,'done',JSON.stringify(deliveryErrors));
 assert.equal(starts,1);assert.equal(getQueuedTaskMessage(task.id),undefined);
 dispatcher.schedule(task.id);deferred.shift()!();await new Promise(r=>setTimeout(r,20));assert.equal(starts,1);
 const count=()=> (db.prepare('SELECT count(*) AS n FROM tasks').get() as {n:number}).n;
 const before=count();assert.equal((await post({content:'',settings:{mode:'goal'}})).status,400);assert.equal(count(),before);
 assert.equal((await post({content:'x',settings:{mode:'bad'}})).status,400);assert.equal(count(),before);
 db.exec("CREATE TRIGGER reject_start BEFORE INSERT ON task_message_queue BEGIN SELECT RAISE(FAIL, 'cannot save initial message'); END");
 assert.equal((await post({content:'x'})).status,500);assert.equal(count(),before,'queue write failure rolls back task creation');
} finally {server.close();await once(server,'close');db.close();await rm(root,{recursive:true,force:true});}
console.log('Durable first-task message tests passed');
