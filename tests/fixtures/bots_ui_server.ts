// Disposable browser fixture. Run with node scripts/run-tests.mjs tests/fixtures/bots_ui_server.ts.
// No Olympus server, database, Hermes installation, or model provider is imported.
import express from 'express';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import type { BotMessage, TaskMessage } from '../../shared/types.js';

const app = express();
app.use(express.json());
const profiles = ['default', 'writer', 'reviewer'].map((id, index) => ({
  id, displayName: ['Hermes', 'Writer', 'Reviewer'][index], label: ['Hermes', 'Writer', 'Reviewer'][index],
  description: 'Disposable browser fixture', active: true, isDefault: index === 0,
  capabilities: { settings: true, soul: true, workspace: true, skills: true, scheduledTasks: true },
  health: { status: 'ready', issues: [] },
}));
const task = (profileId: string) => ({
  id: `bot-${profileId}`, title: `${profileId} bot`, description: '', kind: 'bot', status: 'in_progress',
  profile_name: profileId === 'default' ? null : profileId, project_id: null, created_at: 1, updated_at: 1,
});
const histories = new Map(profiles.map(profile => [profile.id, [{
  id: `hello-${profile.id}`, task_id: task(profile.id).id, role: 'assistant',
  content: `This is the persistent ${profile.displayName} bot conversation.`, created_at: Date.now(),
}] as TaskMessage[]]));
const deliveries: BotMessage[] = ['completed', 'interrupted', 'failed', 'queued'].map((status, index) => ({
  id: `delivery-${index}`, senderProfileId: 'default', recipientProfileId: 'writer',
  senderLabel: 'Hermes', recipientLabel: 'Writer', message: ['Prepare a launch checklist.', 'Review the revised launch copy.', 'Suggest a concise headline.', 'Summarize the next steps.'][index],
  kind: 'request', status: status as BotMessage['status'], error: status === 'failed' ? 'Recipient unavailable.' : null,
  createdAt: Date.now() + index, updatedAt: Date.now() + index,
}));
const requests: { method: string; path: string; profile: string; body: unknown }[] = [];
const live = new Map<string, Set<express.Response>>();
const defaults = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'medium', showReasoning: true };
app.use('/api', (req, res) => {
  const profileId = String(req.query.profile ?? 'default');
  if (!req.path.startsWith('/fixture')) requests.push({ method: req.method, path: req.path, profile: profileId, body: req.body });
  if (req.path === '/fixture/requests') return res.json({ requests });
  if (req.path === '/profiles') return res.json({ profiles });
  if (req.path === '/profiles/attention') return res.json({ profiles: profiles.map(profile => ({ profileId: profile.id, reviewCount: profile.id === 'writer' ? 1 : 0 })) });
  if (req.path === '/installation') return res.json({ name: 'Bots QA' });
  if (req.path === '/channels') return res.json({ channels: [] });
  if (req.path === '/projects') return res.json({ projects: [] });
  if (req.path === '/scheduled-tasks') return res.json({ scheduledTasks: [] });
  if (req.path === '/tasks') return res.json({ tasks: [{ ...task(profileId), id: 'ordinary-task', kind: 'task', title: 'An ordinary task' }, task(profileId)] });
  if (req.path === '/bots') return res.json({ bots: profiles.map(profile => ({ profile, task: task(profile.id) })) });
  if (req.path === '/bots/session') return res.json({ task: task(profileId) });
  if (req.path === '/bots/messages') return res.json({ messages: deliveries.filter(message => [message.senderProfileId, message.recipientProfileId].includes(profileId)) });
  const deliveryAction = req.path.match(/^\/bots\/messages\/([^/]+)\/(retry|cancel)$/);
  if (deliveryAction) {
    const message = deliveries.find(item => item.id === deliveryAction[1]);
    if (!message) return res.status(404).json({ error: 'Unknown delivery' });
    message.status = deliveryAction[2] === 'cancel' ? 'cancelled' : 'queued';
    message.error = null;
    return res.json({});
  }
  if (req.path === '/agent/models') return res.json({ defaultModel: defaults.model, activeProvider: defaults.provider, groups: [{ provider: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture model', source: 'current' }] }] });
  if (req.path === '/agent/defaults') return res.json(defaults);
  if (req.path.endsWith('/agent-settings')) return res.json({ task: { model: null, provider: null, reasoningEffort: null }, defaults, effective: defaults });
  if (req.path.endsWith('/queued-message')) return res.json({ queuedMessage: null });
  if (req.path.endsWith('/interactions')) return res.json({ interactions: [] });
  if (req.path.endsWith('/live') || req.path === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': fixture connected\n\n');
    if (req.path === '/events') {
      res.write(`data: ${JSON.stringify({ type: 'task_runs_snapshot', runs: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'task_created', task: task(profileId) })}\n\n`);
    } else {
      const subscribers = live.get(profileId) ?? new Set();
      subscribers.add(res); live.set(profileId, subscribers);
      req.on('close', () => subscribers.delete(res));
    }
    return;
  }
  if (/^\/tasks\/[^/]+\/messages$/.test(req.path)) {
    const messages = histories.get(profileId)!;
    if (req.method === 'POST') {
      const id = String(Date.now());
      messages.push({ id, task_id: task(profileId).id, role: 'user', content: req.body.content, created_at: Date.now() });
      res.status(202).json({ runId: `run-${id}` });
      setTimeout(() => {
        const content = `Fixture reply from ${profiles.find(profile => profile.id === profileId)!.displayName}.`;
        messages.push({ id: `reply-${id}`, task_id: task(profileId).id, role: 'assistant', content, created_at: Date.now() });
        for (const subscriber of live.get(profileId) ?? []) {
          subscriber.write(`data: ${JSON.stringify({ type: 'text_delta', content })}\n\n`);
          subscriber.write(`data: ${JSON.stringify({ type: 'done', sessionId: task(profileId).id })}\n\n`);
        }
      }, 200);
      return;
    }
    return res.json({ messages, pageInfo: { hasOlder: false, olderCursor: null } });
  }
  res.status(404).json({ error: `Unimplemented fixture endpoint ${req.method} ${req.path}` });
});
const vite = await createServer({ root: resolve('client'), configFile: resolve('client/vite.config.ts'), server: { middlewareMode: true, hmr: false }, appType: 'spa' });
app.use(vite.middlewares);
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Bots UI fixture: http://127.0.0.1:${address.port}/bots?profile=default`);
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); void vite.close().then(() => process.exit(0)); });
