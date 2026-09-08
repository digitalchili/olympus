import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import type { Task } from '../shared/types.js';

// Explicitly disposable, credential-free fixture. Never imports the production app.
const root = await mkdtemp(resolve('.tmp-native-qa-inline-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'state/test.db');
const workspace = join(root, 'hermes/workspace');
await mkdir(workspace, { recursive: true });
const { LocalProfileRegistry } = await import('../server/local-profiles.js');
const { createTaskArtifactsRouter, publishTaskAttachments } = await import('../server/task-artifacts.js');
const registry = new LocalProfileRegistry(process.env.HERMES_HOME);
const task = { id: 'inline-preview-fixture', title: 'Explore homepage directions', profile_name: null, status: 'in_progress', workdir: workspace } as Task;
const designs = [
  { id: 'a', title: 'Editorial', description: 'Warm paper, generous whitespace, and a restrained serif headline.', bg: '#f6f1e8', ink: '#292b27', accent: '#b95434', font: 'Georgia,serif', heading: 'Make room<br>for good ideas.' },
  { id: 'b', title: 'Expressive', description: 'High contrast, oversized typography, and a playful graphic.', bg: '#332065', ink: '#f3f1ff', accent: '#d6fd74', font: 'Arial,sans-serif', heading: 'Small team.<br>Big ideas.' },
  { id: 'c', title: 'Quiet modern', description: 'Cool tones, crisp typography, and a calmer product-led direction.', bg: '#e9f1f4', ink: '#172e3a', accent: '#477b89', font: 'Arial,sans-serif', heading: 'A little space.<br>A fresh start.' },
];
for (const d of designs) {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:${d.bg};color:${d.ink};font-family:${d.font}}nav{display:flex;justify-content:space-between;font:12px Arial;letter-spacing:.1em}main{max-width:920px;margin:60px auto}small{font:11px Arial;letter-spacing:.18em}h1{font-size:clamp(38px,7vw,84px);line-height:1.05;font-weight:500;margin:22px 0}p{max-width:360px;font:16px/1.6 Arial;opacity:.75}button{border:0;border-radius:30px;padding:15px 23px;background:${d.accent};color:${d.id === 'b' ? '#252338' : '#fff'};font:600 13px Arial;cursor:pointer}.shape{float:right;width:30%;aspect-ratio:1;border-radius:50% 50% 8% 50%;background:${d.accent};opacity:.85;margin-top:30px}#security{font:10px Arial;opacity:.5;margin-top:25px}</style></head><body><nav><b>FIELDNOTES / STUDIO</b><span>ABOUT &nbsp; WORK</span></nav><main><small>INDEPENDENT THINKING, THOUGHTFULLY MADE</small><div class="shape"></div><h1>${d.heading}</h1><p>A place for thoughtful work and new perspectives. A design concept for a small creative studio.</p><button id="demo" onclick="this.textContent='Let’s make something';document.getElementById('state').textContent='Local interaction works'">Explore the studio ↗</button><p id="state"></p><div id="security"></div></main><script>let isolated=false;try{parent.document.body.dataset.previewEscaped='yes'}catch{isolated=true}document.getElementById('security').textContent=isolated?'Isolated from parent':'PARENT ACCESSIBLE';window['fe'+'tch']('/qa/probe').catch(()=>{document.body.dataset.network='blocked'});</script></body></html>`;
  await writeFile(join(workspace, `${d.id}.html`), html);
}
const navigationPath = join(workspace, 'navigation-probe.html');
await writeFile(navigationPath, `<!doctype html><html><body><button onclick="location.assign('/qa/probe?navigation=1')">Test blocked navigation</button></body></html>`);
const navigationAttachments = await publishTaskAttachments(task, 'MEDIA:navigation-probe.html', registry);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y9sAAAAASUVORK5CYII=', 'base64');
await writeFile(join(workspace, 'swatch.png'), png);
const content = 'Here are three distinct homepage concepts. Choose one to develop, or describe a combination.\n\n```olympus-preview\n' + JSON.stringify({ id: 'homepage-r1', title: 'Homepage directions', drafts: designs.map(d => ({ id: d.id, title: d.title, description: d.description, path: `${d.id}.html` })) }) + '\n```\n\nMEDIA:swatch.png';
const attachments = await publishTaskAttachments(task, content, registry);
if (attachments.filter(a => a.preview).length !== 4) throw new Error('Fixture did not publish four real previews');
const app = express();
app.use(express.json());
app.use('/api/tasks', createTaskArtifactsRouter({ getTask: id => id === task.id ? task : undefined, registry }));
let probes = 0;
app.all('/qa/probe', (_req, res) => { probes++; res.json({ probes }); });
app.get('/qa/status', (_req, res) => res.json({ ok: true, probes, root, artifacts: attachments.length }));
app.get('/qa/navigation-preview', (_req, res) => res.json(navigationAttachments));
app.get('/qa/message', (_req, res) => res.json({ taskId: task.id, content, attachments }));
app.get('/', (_req, res) => res.redirect('/tests/fixtures/inline-preview.html'));
const vite = await createViteServer({ root: process.cwd(), configFile: resolve('client/vite.config.ts'), css: { postcss: resolve('client') }, server: { middlewareMode: true }, appType: 'mpa' });
app.use(vite.middlewares);
const server = createServer(app);
server.listen(Number(process.env.QA_PORT || 4179), '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: 'http://127.0.0.1:4179', root })));
async function close() { await vite.close(); server.close(() => process.exit(0)); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
