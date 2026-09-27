// Disposable real HTTP/SSE routes with a fake agent. Never opens a user's Hermes home.
// --benchmark emits JSON; --ui exposes the real chat hook for local render checks.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-response-perf-'));
const source = resolve(process.env.PERF_SOURCE_ROOT || '.');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state/db.sqlite');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const moduleAt = (file: string) => import(pathToFileURL(join(source, file)).href);
const { default: api, adapter } = await moduleAt('server/app.ts');
const { default: db } = await moduleAt('server/db/index.ts');
const { insertTask, getTask } = await moduleAt('server/db/queries.ts');
const { getLatestTaskAgentRun } = await moduleAt('server/db/task-agent-runs.ts');
const traces: Record<string, any>[] = [];
const originalError = console.error;
console.error = (...values) => {
  if (typeof values[0] === 'string' && values[0].startsWith('[olympus-perf] ')) traces.push(JSON.parse(values[0].slice(15)));
  else originalError(...values);
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
const dirs: Record<string, string> = {};
for (const [name, files, bytes] of [['small-git', 32, 4096], ['large-git', 512, 16384]] as const) {
  const cwd = dirs[name] = join(root, name);
  await mkdir(cwd);
  for (let i = 0; i < files; i++) await writeFile(join(cwd, `${i}.txt`), 'x'.repeat(bytes));
  await git(cwd, 'init', '-q');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
}
const contexts = new Map<string, { history: any[]; nativeStarted?: number; nativeDone?: number; starts: number }>();
const delay = process.argv.includes('--ui') ? 800 : 20;
adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
adapter.getDefaults = async () => ({ provider: 'fixture', model: 'fixture', reasoningEffort: 'low', showReasoning: true });
adapter.getModels = async () => ({ defaultModel: 'fixture', activeProvider: 'fixture', groups: [] });
adapter.getMessages = async (id: string) => contexts.get(id)?.history ?? [];
adapter.getMessagePage = async (id: string) => ({ messages: (contexts.get(id)?.history ?? []).slice(-60), pageInfo: { hasOlder: false, olderCursor: null } });
adapter.getSession = async () => null;
adapter.chatStream = async function* (id: string, content: string) {
  const context = contexts.get(id)!;
  context.starts++;
  // Fixed synthetic history parsing cost; this is not a native Hermes history benchmark.
  JSON.parse(JSON.stringify(context.history));
  context.nativeStarted = performance.now();
  await sleep(delay);
  yield { type: 'thinking_delta', content: 'Fixture thinking.' };
  await sleep(delay);
  yield { type: 'text_delta', content: 'FIRST_ANSWER ' };
  await sleep(delay);
  yield { type: 'text_delta', content: 'FINAL_ANSWER' };
  context.history.push({ id: `${id}-user`, task_id: id, role: 'user', content, created_at: Date.now() },
    { id: `${id}-answer`, task_id: id, role: 'assistant', content: 'FIRST_ANSWER FINAL_ANSWER', created_at: Date.now() });
  context.nativeDone = performance.now();
  yield { type: 'done', sessionId: id };
};
const app = express();
app.use(express.json());
let botTask: any;
app.post('/fixture/task', (req, res) => {
  const scenario = ['plain', 'bot', 'small-git', 'large-git', 'long-history'].includes(req.body.scenario) ? req.body.scenario : 'plain';
  const task = scenario === 'bot' && botTask ? botTask : insertTask({ title: 'Disposable performance fixture', status: 'in_progress', profile_name: 'default',
    kind: scenario === 'bot' ? 'bot' : 'task', workdir: dirs[scenario] || null });
  if (scenario === 'bot') botTask = task;
  const history = scenario === 'long-history' ? Array.from({ length: 1000 }, (_, i) => ({ id: `${task.id}-${i}`, task_id: task.id,
    role: i % 2 ? 'assistant' : 'user', content: `Synthetic history ${i}: ` + 'x'.repeat(256), created_at: i })) : [];
  contexts.set(task.id, { history, starts: 0 });
  res.json({ taskId: task.id });
});
app.get('/fixture/result/:id', (req, res) => {
  const context = contexts.get(req.params.id);
  const run = getLatestTaskAgentRun(req.params.id);
  res.json({ starts: context?.starts, nativeStarted: context?.nativeStarted, nativeDone: context?.nativeDone,
    runStatus: run?.status, taskStatus: getTask(req.params.id)?.status, traces: traces.filter(row => row.runId === run?.run_id || row.runId === run?.runId) });
});
app.use(api);
let vite: any;
if (process.argv.includes('--ui')) {
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(root, 'vite'),
    resolve: { alias: { '@shared': resolve('shared') } }, server: { middlewareMode: true, hmr: false }, appType: 'mpa' });
  app.use(vite.middlewares);
}
const server = app.listen(Number(process.env.PERF_PORT || 0), process.env.PERF_HOST || '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const close = async () => {
  server.closeAllConnections(); server.close(); await vite?.close();
  db.close(); console.error = originalError; await rm(root, { recursive: true, force: true });
};
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });

if (!process.argv.includes('--benchmark')) {
  console.log(JSON.stringify({ base, ui: `${base}/tests/fixtures/response-performance.html` }));
} else {
  try {
    const samples = [];
    for (const scenario of ['plain', 'bot', 'small-git', 'large-git', 'long-history']) {
      for (let index = -2; index < Number(process.env.PERF_SAMPLES || 30); index++) {
        const { taskId } = await (await fetch(`${base}/fixture/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario }) })).json();
        const abort = new AbortController();
        const stream = await fetch(`${base}/api/tasks/${taskId}/live?profile=default`, { signal: abort.signal });
        let start = 0, activity: number | undefined, answer: number | undefined, terminal = 0, text = '';
        const events: string[] = [];
        const read = (async () => {
          let buffer = '';
          for await (const bytes of stream.body!) {
            buffer += new TextDecoder().decode(bytes);
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
              if (!data) continue;
              const event = JSON.parse(data);
              if (['thinking_delta', 'text_delta'].includes(event.type) && event.content) {
                activity ??= performance.now() - start;
                if (event.type === 'text_delta') { answer ??= performance.now() - start; text += event.content; }
                events.push(event.type);
              }
              if (event.type === 'error') throw new Error('Fixture run failed');
              if (event.type === 'done') { terminal = performance.now() - start; return; }
            }
          }
        })();
        const traceStart = traces.length;
        start = performance.now();
        const response = await fetch(`${base}/api/tasks/${taskId}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":"Say the fixture answer."}' });
        assert.equal(response.status, 202, await response.text());
        const accepted = performance.now() - start;
        await read; abort.abort();
        assert.equal(text, 'FIRST_ANSWER FINAL_ANSWER');
        assert.deepEqual(events, ['thinking_delta', 'text_delta', 'text_delta']);
        assert.ok(activity! < answer! && answer! < terminal);
        const context = contexts.get(taskId)!;
        assert.equal(context.starts, 1);
        assert.equal(getLatestTaskAgentRun(taskId)?.status, 'done');
        const sample = { scenario, index, accepted, firstActivity: activity, firstAnswerReceived: answer, terminal,
          sendToFakeAgentStart: context.nativeStarted! - start, afterNativeDone: start + terminal - context.nativeDone!, records: traces.slice(traceStart) };
        samples.push(sample);
      }
    }
    console.log('PERF_RESULT ' + JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      source, fakeAgentDelayMs: delay, concurrency: 1, diagnostics: process.env.OLYMPUS_PERF_DIAGNOSTICS === '1', samples }));
  } finally { await close(); }
}
