import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const legacy = new Database(process.env.DB_PATH!);
let schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
schema = schema.replace(/(CREATE TABLE IF NOT EXISTS project_repository_links \([\s\S]*?updated_at\s+INTEGER NOT NULL)\n\);/, '$1,\n UNIQUE(provider, provider_repository_id)\n);');
legacy.exec(schema);
legacy.exec(`INSERT INTO projects VALUES ('one','One','one','First project','default',1,1), ('two','Two','two','Second project','default',1,1);
  INSERT INTO studio_github_installations (id,account_login,account_type,label,permission_mode,created_at,updated_at) VALUES (1,'fixture','Organization','Fixture','read_write',1,1);
  INSERT INTO project_repository_links VALUES ('one','github',1,1,'fixture','fixture/repo',1,'main','https://example.invalid','/tmp/fixture.git','branch_pr',1,1);`);
// The child row would be silently lost by an ordinary DROP with FKs enabled.
legacy.exec("INSERT INTO project_repository_sync VALUES ('one','github:1',123,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1)");
const before = legacy.prepare('SELECT * FROM project_repository_sync').all();
legacy.close();
execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e', "const {default:db}=await import('./server/db/index.ts'); db.close();"], { env: process.env });
const upgraded = new Database(process.env.DB_PATH!);
assert.deepEqual(upgraded.prepare('SELECT * FROM project_repository_sync').all(), before, 'preserve dependent sync evidence');
upgraded.exec("INSERT INTO project_repository_links SELECT 'two',provider,provider_repository_id,installation_id,owner,full_name,private,default_branch,html_url,clone_url,mode,created_at,updated_at FROM project_repository_links WHERE project_id='one'");
assert.equal((upgraded.prepare('SELECT COUNT(*) n FROM project_repository_links').get() as any).n, 2);
assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
upgraded.close();
execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e', "const {default:db}=await import('./server/db/index.ts'); db.close();"], { env: process.env });
console.log('Shared repository link migration preserves links and permits two Projects');
