import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { getAllTasks } from '../db/queries.js';
import { resolveHermesHome } from '../paths.js';

export const searchRouter = Router();

const MAX_RESULTS = 40;
const MAX_TASK_IDS_PER_QUERY = 900;

export type TaskSearchResult = {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  role: 'task' | 'user' | 'assistant' | 'system' | 'tool';
  snippet: string;
  timestamp: number;
};

function toFtsQuery(query: string): string | null {
  const terms = query
    .trim()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.map((term) => `"${term.replace(/"/g, '')}"*`)
    .filter(Boolean);
  return terms?.length ? terms.join(' AND ') : null;
}

function excerpt(text: string, maxLength = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function taskMetadataMatches(query: string): TaskSearchResult[] {
  const normalized = query.toLocaleLowerCase();
  return getAllTasks()
    .filter((task) => `${task.title}\n${task.description ?? ''}`.toLocaleLowerCase().includes(normalized))
    .slice(0, MAX_RESULTS)
    .map((task) => ({
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      role: 'task' as const,
      snippet: excerpt(task.description || task.title),
      timestamp: task.updated_at,
    }));
}

function searchHermesMessages(query: string): TaskSearchResult[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const tasks = getAllTasks();
  if (!tasks.length) return [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskIds = tasks.slice(0, MAX_TASK_IDS_PER_QUERY).map((task) => task.id);
  const hermesDbPath = join(resolveHermesHome(), 'state.db');
  if (!existsSync(hermesDbPath)) return [];

  const db = new Database(hermesDbPath, { readonly: true, fileMustExist: true });
  try {
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT
        m.session_id AS task_id,
        m.role,
        m.timestamp,
        snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND m.session_id IN (${placeholders})
      ORDER BY bm25(messages_fts), m.timestamp DESC
      LIMIT ?
    `).all(ftsQuery, ...taskIds, MAX_RESULTS) as Array<{
      task_id: string;
      role: TaskSearchResult['role'];
      timestamp: number;
      snippet: string;
    }>;

    return rows.flatMap((row) => {
      const task = taskById.get(row.task_id);
      return task ? [{
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
        role: row.role,
        snippet: row.snippet,
        timestamp: row.timestamp * 1000,
      }] : [];
    });
  } finally {
    db.close();
  }
}

searchRouter.get('/', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 2) return res.json({ results: [] });

  try {
    const metadata = taskMetadataMatches(query);
    const messages = searchHermesMessages(query);
    const seen = new Set<string>();
    const results = [...metadata, ...messages].filter((result) => {
      const key = `${result.taskId}:${result.role}:${result.snippet}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_RESULTS);
    res.json({ results });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Task search is unavailable' });
  }
});
