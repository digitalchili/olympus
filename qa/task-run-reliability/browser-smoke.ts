import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
if (process.env.OLYMPUS_QA_ISOLATED !== '1') throw new Error('Use qa/task-run-reliability/run-isolated.py; this fixture must not touch live state.');
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.OLYMPUS_PLAYWRIGHT_MODULE || 'playwright');
await mkdir(process.env.HERMES_HOME!,{recursive:true});
await writeFile(join(process.env.HERMES_HOME!,'config.yaml'),'{}\n');
const {default:app,adapter}=await import('../../server/app.js');
const {insertTask}=await import('../../server/db/queries.js');
const {createTaskAgentRun,finishTaskAgentRun}=await import('../../server/db/task-agent-runs.js');
const {putQueuedTaskMessage}=await import('../../server/db/task-message-queue.js');
const outputDir=process.env.OLYMPUS_QA_OUTPUT_DIR || '.tmp-olympus-portable-reliability';await mkdir(outputDir,{recursive:true});
const defaults={model:'gpt-5.5',provider:'openai-codex',reasoningEffort:'xhigh' as const,baseUrl:null,apiMode:null,showReasoning:true};
adapter.healthCheck=async()=>true;
adapter.getDefaults=async()=>defaults;
adapter.getModels=async()=>({defaultModel:defaults.model,activeProvider:defaults.provider,groups:[{provider:'openai-codex',models:[{id:'gpt-5.5',label:'GPT-5.5',source:'current'}]}]});
adapter.getSessionMetadata=async()=>null;
adapter.getBackgroundWork=async()=>({available:true,work:[{id:'fixture-survivor',kind:'process',status:'running'}]});
let starts=0; adapter.chatStream=async function*(sessionId){starts++;yield {type:'done',sessionId};};
const failed=insertTask({title:'Reliability browser fixture',status:'in_progress',profile_name:'default'});
const succeeded=insertTask({title:'Successful reference fixture',status:'in_review',profile_name:'default'});
for(const [task,status] of [[failed,'error'],[succeeded,'done']] as const){createTaskAgentRun({runId:task.id,taskId:task.id,kind:'chat',status:'streaming',startedAt:100});finishTaskAgentRun(task.id,status,200,status==='error'?'run_runtime_timeout':undefined);}
adapter.getMessagePage=async(_sessionId,taskId)=>({messages:[{id:'fixture-partial',task_id:taskId,role:'assistant',content:taskId===failed.id?'Preserved partial implementation checkpoint':'Verified successful fixture response',created_at:150}],pageInfo:{hasOlder:false,olderCursor:null}});
putQueuedTaskMessage({id:'fixture-queue',taskId:failed.id,content:'Continue the implementation',settings:{mode:'task'},invitedProfileIds:[],collaborationScope:'discussion',confirmPersistentCollaboration:false,createdAt:200,updatedAt:200});
const dist=resolve('dist/server/client/dist');app.use(express.static(dist));app.get(/.*/,(_req,res)=>res.sendFile(join(dist,'index.html')));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.OLYMPUS_CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1400,height:1000}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
page.setDefaultTimeout(8000);
// Deliver an explicitly stale SSE snapshot after newer failed history hydration.
// Use the real hook/composer; only the transport response is a fixture.
await page.addInitScript(() => {
  const NativeSource = window.EventSource;
  (window as any).__staleDelivered = 0;
  window.EventSource = class extends NativeSource {
    constructor(url: string | URL, options?: EventSourceInit) {
      super(url, options);
      this.addEventListener('message', () => { (window as any).__staleDelivered++; });
    }
  };
});
await page.route(`**/api/tasks/${failed.id}/live?*`, async (route: any) => {
  const run = { taskId: failed.id, runId: 'stale-previous-run', kind: 'chat', sessionId: failed.id,
    status: 'streaming', startedAt: 50, updatedAt: 60,
    messages: [{ id: 'stale-only-message', role: 'assistant', content: 'STALE STREAM MUST NOT REAPPEAR', created_at: 60 }] };
  await route.fulfill({status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({type: 'snapshot',run})}\n\n`});
});
try{
 await page.goto(`http://127.0.0.1:${port}/tasks/${failed.id}?profile=default`);
 await page.getByText('Run paused: run cap reached',{exact:true}).waitFor();
 await page.getByText('Preserved partial implementation checkpoint',{exact:true}).waitFor();
 await page.getByText('Paused after unfinished run',{exact:true}).waitFor();
 await page.waitForFunction(() => (window as any).__staleDelivered > 0);
 assert.equal(await page.getByText('STALE STREAM MUST NOT REAPPEAR',{exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Send now',exact:true}).isEnabled(),true,'stale streaming state cannot disable deliberate retry');
 assert.equal(starts,0,'hydration does not automatically replay failed task');
 await page.reload();await page.getByText('Run paused: run cap reached',{exact:true}).waitFor();
 assert.equal(starts,0,'reload does not replay the queue');
 await page.getByRole('button',{name:'Send now',exact:true}).click();
 await page.getByText(/This task still has background work/).first().waitFor();assert.equal(starts,0);
 await page.screenshot({path:join(outputDir,'recovery-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.getByText('Run paused: run cap reached',{exact:true}).waitFor();
 await page.screenshot({path:join(outputDir,'recovery-mobile.png'),fullPage:true});
 await page.goto(`http://127.0.0.1:${port}/tasks/${succeeded.id}?profile=default`);await page.getByText('Verified successful fixture response',{exact:true}).waitFor();
 assert.equal(await page.getByText('Run paused: run cap reached',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['real rendered failure banner','partial transcript retained','reload persistence','no automatic queued retry','manual retry blocked while work survives','desktop and mobile','success path not blocked','no browser JS errors']}));
}catch(error){console.error('BROWSER_DIAGNOSTIC',JSON.stringify({url:page.url(),errors,body:await page.locator('body').innerText()}));await page.screenshot({path:join(outputDir,'browser-failure.png'),fullPage:true});throw error;}finally{await browser.close();server.closeAllConnections();server.close();}

