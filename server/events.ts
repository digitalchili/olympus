import type { Response } from 'express';
import type { BoardEvent, Task } from '../shared/types.js';
import { getTask } from './db/queries.js';
import type { LocalProfileTarget } from './local-profiles.js';
import { taskBelongsToProfile } from './profile-context.js';

export type { BoardEvent };

const clients = new Map<Response, LocalProfileTarget>();
const projectClients = new Map<Response, string>();

const KEEPALIVE_INTERVAL_MS = 30_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    for (const client of [...clients.keys(), ...projectClients.keys()]) {
      try {
        client.write(':keepalive\n\n');
      } catch {
        clients.delete(client);
        projectClients.delete(client);
      }
    }
    if (clients.size === 0 && projectClients.size === 0) {
      clearInterval(keepaliveTimer!);
      keepaliveTimer = null;
    }
  }, KEEPALIVE_INTERVAL_MS);
}

export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

export function addClient(res: Response, profile: LocalProfileTarget) {
  clients.set(res, profile);
  res.on('close', () => clients.delete(res));
  startKeepalive();
}

export function addProjectClient(res: Response, projectId: string) {
  projectClients.set(res, projectId);
  res.on('close', () => projectClients.delete(res));
  startKeepalive();
}

function writeEvent(res: Response, event: BoardEvent): boolean {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  try {
    return res.write(data);
  } catch {
    return false;
  }
}

export function sendEvent(res: Response, event: BoardEvent): void {
  writeEvent(res, event);
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
    if (!writeEvent(client, event)) clients.delete(client);
  }
  if (scopedTask.project_id) {
    for (const [client, projectId] of projectClients) {
      if (scopedTask.project_id !== projectId) continue;
      if (!writeEvent(client, event)) projectClients.delete(client);
    }
  }
}

export function closeClientsForProfile(profileId: string): void {
  for (const [client, profile] of clients) {
    if (profile.id !== profileId) continue;
    clients.delete(client);
    try {
      client.end();
    } catch {
      // The connection is already gone.
    }
  }
  if (clients.size === 0 && projectClients.size === 0 && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

export function closeClientsForRestart(): void {
  const event = 'data: {"type":"maintenance_reconnect"}\n\n';
  for (const client of [...clients.keys(), ...projectClients.keys()]) {
    try {
      client.write(event);
      client.end();
    } catch {
      // The connection is already gone.
    }
  }
  clients.clear();
  projectClients.clear();
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}
