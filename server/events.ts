import type { Response } from 'express';
import type { BoardEvent, Task } from '../shared/types.js';
import { getTask } from './db/queries.js';
import type { LocalProfileTarget } from './local-profiles.js';
import { taskBelongsToProfile } from './profile-context.js';
import { createSseWriter, type SseWriter } from './sse-writer.js';

export type { BoardEvent };

const clients = new Map<SseWriter, LocalProfileTarget>();
const projectClients = new Map<SseWriter, string>();

const KEEPALIVE_INTERVAL_MS = 30_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function stopKeepaliveIfEmpty() {
  if (clients.size === 0 && projectClients.size === 0 && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    for (const client of [...clients.keys(), ...projectClients.keys()]) {
      client.keepalive();
    }
    stopKeepaliveIfEmpty();
  }, KEEPALIVE_INTERVAL_MS);
}

export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function registerClient<T>(res: Response, registry: Map<SseWriter, T>, scope: T): SseWriter {
  const writer = createSseWriter(res);
  const cleanup = () => {
    registry.delete(subscriber);
    res.off('close', cleanup);
    res.off('error', cleanup);
    res.off('finish', cleanup);
    stopKeepaliveIfEmpty();
  };
  const subscriber = { ...writer, close() { cleanup(); writer.close(); } };
  registry.set(subscriber, scope);
  res.on('close', cleanup);
  res.on('error', cleanup);
  res.on('finish', cleanup);
  startKeepalive();
  return subscriber;
}

export function addClient(res: Response, profile: LocalProfileTarget): SseWriter {
  return registerClient(res, clients, profile);
}

export function addProjectClient(res: Response, projectId: string): SseWriter {
  return registerClient(res, projectClients, projectId);
}

export function bootstrapEvents(writer: SseWriter, events: readonly BoardEvent[]): void {
  writer.bootstrap(events.map(event => `data: ${JSON.stringify(event)}\n\n`));
}

function taskForEvent(event: BoardEvent, task?: Task): Task | undefined {
  if (task) return task;
  if (event.type === 'task_created' || event.type === 'task_updated') return event.task;
  if (event.type === 'task_run_updated') return getTask(event.run.taskId);
  if (event.type === 'delegation_run_updated') return getTask(event.run.task_id);
  return undefined;
}

export function broadcast(event: BoardEvent, task?: Task) {
  const scopedTask = taskForEvent(event, task);
  if (!scopedTask) return;
  for (const [client, profile] of clients) {
    if (!taskBelongsToProfile(scopedTask, profile)) continue;
    client.send(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (scopedTask.project_id) {
    for (const [client, projectId] of projectClients) {
      if (scopedTask.project_id !== projectId) continue;
      client.send(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
}

export function closeClientsForProfile(profileId: string): void {
  for (const [client, profile] of clients) {
    if (profile.id !== profileId) continue;
    client.close();
  }
  stopKeepaliveIfEmpty();
}

export function closeClientsForRestart(): void {
  const event = 'data: {"type":"maintenance_reconnect"}\n\n';
  for (const client of [...clients.keys(), ...projectClients.keys()]) {
    client.send(event);
    client.close();
  }
  clients.clear();
  projectClients.clear();
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}
