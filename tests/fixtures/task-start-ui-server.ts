// Disposable real-route UI fixture with fake Hermes; never calls a model provider.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import type { TaskMessage } from '../../shared/types.js';
const root=await mkdtemp(join(tmpdir(),'task-start-ui-'));
process.env.HERMES_HOME=join(root,'hermes');process.env.OLYMPUS_DISPATCH_HOME=join(root,'state');process.env.DB_PATH=join(root,'db.sqlite');
for(const [id,name] of [['default','Somboon'],['som','Som'],['design-director','Design Director']]){
 const home=id==='default'?process.env.HERMES_HOME:join(process.env.HERMES_HOME,'profiles',id);
 await mkdir(home,{recursive:true});await writeFile(join(home,'config.yaml'),'{}');await writeFile(join(home,'profile.yaml'),`displayName: ${name}\nactive: true\n`);
}
const {default: api,adapter}=await import('../../server/app.js');
const {default: db}=await import('../../server/db/index.js');
const {insertTask,getTask}=await import('../../server/db/queries.js');
const {getQueuedTaskMessage}=await import('../../server/db/task-message-queue.js');
const {configureQueuedMessageDispatcher,createQueuedMessageDispatcher,assertQueuedMessageDeliveryResponse}=await import('../../server/queued-message-dispatcher.js');
const orphan=insertTask({title:'Find Replacement Wine for AU0080',description:'Replacement for AU0080',status:'in_progress',profile_name:'som',handling_profile_id:'som'});
const defaults={provider:'fixture',model:'fixture-model',reasoningEffort:'low' as const,showReasoning:true,baseUrl:null,apiMode:null};
adapter.getDefaults=async()=>defaults;
adapter.getModels=async()=>({defaultModel:'fixture-model',activeProvider:'fixture',groups:[]}) as never;
adapter.generateTitle=async()=>({title:'Find Replacement Wine for AU0080'});
adapter.getBackgroundWork=async()=>({available:true,work:[]});
adapter.setGoal=async(_id,goal)=>{
 if(goal.includes('fail goal')){await new Promise(resolve=>setTimeout(resolve,2500));throw new Error('Fixture goal startup failure');}
 return {goal:'Replacement',status:'active',turnsUsed:0,maxTurns:20};
};
adapter.getGoalStatus=async()=>null;
adapter.evaluateGoal=async()=>({status:'done',shouldContinue:false,verdict:'done',reason:'finished',message:''});
const histories=new Map<string,TaskMessage[]>();
let starts=0;
adapter.chatStream=async function*(sessionId,content){
 starts++;const now=Date.now();const rows:TaskMessage[]=[{id:'user-'+starts,task_id:sessionId,role:'user',content,created_at:now}];histories.set(sessionId,rows);
 yield {type:'text_delta',content:'Checking saved wine inventory…'};
 await new Promise(r=>setTimeout(r,1000));
 rows.push({id:'reply-'+starts,task_id:sessionId,role:'assistant',content:'Fixture: replacement research completed.',created_at:Date.now()});
 yield {type:'text_delta',content:'\n\nFixture: replacement research completed.'};yield {type:'done',sessionId};
};
adapter.getMessagePage=async(sessionId)=>({messages:histories.get(sessionId)??[],pageInfo:{hasOlder:false,olderCursor:null}});
adapter.getMessages=async(sessionId)=>histories.get(sessionId)??[];
const app=express();
app.get('/api/fixture/state',(_req,res)=>res.json({starts,orphanId:orphan.id,queues:db.prepare('SELECT task_id,id,content FROM task_message_queue').all()}));
app.get('/api/profiles/attention',(_req,res)=>res.json({profiles:[{profileId:'default',reviewCount:1}]}));
app.get('/api/scheduled-tasks',(_req,res)=>res.json({scheduledTasks:[]}));
app.use(api);
const vite=await createServer({root:resolve('client'),configFile:resolve('client/vite.config.ts'),cacheDir:join(root,'vite-cache'),server:{middlewareMode:true,hmr:{port:4182}},appType:'spa'});app.use(vite.middlewares);
const server=app.listen(4181,'127.0.0.1',()=>console.log(`Task startup UI: http://127.0.0.1:4181/tasks/${orphan.id}?profile=som`));
configureQueuedMessageDispatcher(createQueuedMessageDispatcher({load:getQueuedTaskMessage,isActive:()=>false,deliver:async(id,message)=>{
 await assertQueuedMessageDeliveryResponse(await fetch(`http://127.0.0.1:4181/api/tasks/${id}/messages?profile=${getTask(id)!.profile_name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...message,queuedMessageId:message.id})}));
},onError:(_id,error)=>console.error(error)}));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();void vite.close().then(async()=>{db.close();await rm(root,{recursive:true,force:true});process.exit(0);});});
