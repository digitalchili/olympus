import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const root=mkdtempSync(join(tmpdir(),'failure-migration-'));
process.env.DB_PATH=join(root,'old.db');
// The base schema is deliberately pre-migration (error_code is added by index.ts).
const old=new Database(process.env.DB_PATH);
old.exec(readFileSync(new URL('../server/db/schema.sql',import.meta.url),'utf8'));
assert.equal((old.prepare('PRAGMA table_info(task_agent_runs)').all() as Array<{name:string}>).some(c=>c.name==='error_code'),false);
old.prepare("INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('legacy','Legacy task','in_progress',1,1)").run();
old.prepare("INSERT INTO task_agent_runs (run_id,task_id,kind,status,started_at,updated_at,completed_at) VALUES ('legacy-run','legacy','chat','done',1,2,2)").run();
old.close();
const {default:db}=await import('../server/db/index.js');
const {getLatestTaskAgentRun,createTaskAgentRun,finishTaskAgentRun}=await import('../server/db/task-agent-runs.js');
try {
 assert.equal(getLatestTaskAgentRun('legacy')?.status,'done');
 assert.equal(getLatestTaskAgentRun('legacy')?.errorCode??null,null);
 createTaskAgentRun({runId:'new',taskId:'legacy',kind:'chat',status:'streaming',startedAt:3});
 finishTaskAgentRun('new','error',4,'run_runtime_timeout');
 assert.equal(getLatestTaskAgentRun('legacy')?.errorCode,'run_runtime_timeout');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get().n,2);
} finally {db.close();rmSync(root,{recursive:true,force:true});}
console.log('Legacy task-run failure-column migration tests passed');
