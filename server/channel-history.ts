import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  HermesChannelMessage,
  HermesChannelMessagesResult,
  HermesChannelThread,
  HermesChannelThreadsResult,
} from '../shared/types.js';

const MAX_THREADS = 100;
const MAX_MESSAGES = 500;
const MAX_CONTENT_LENGTH = 16_000;

type DispatchDb = import('better-sqlite3').Database;

interface SourceSession {
  id: string;
  parentSessionId: string | null;
  startedAt: number;
  title: string | null;
  displayName: string | null;
}

interface SourceMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  contentTruncated: boolean;
  timestamp: number;
}

interface SourceThread {
  rootSessionId: string;
  tipSessionId: string;
  title: string;
  messages: SourceMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChannelHistorySource {
  listThreads(hermesHome: string, channelId: string): SourceThread[] | null;
}

function opaqueId(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

function publicText(raw: string | null): string {
  if (!raw) return '';
  if (!raw.startsWith('\0json:')) return raw.trim();

  try {
    const blocks = JSON.parse(raw.slice(6)) as unknown;
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((block): block is { type: 'text'; text: string } => {
        if (!block || typeof block !== 'object') return false;
        const value = block as Record<string, unknown>;
        return value.type === 'text' && typeof value.text === 'string';
      })
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

function boundedContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_CONTENT_LENGTH) return { content, truncated: false };
  return { content: content.slice(0, MAX_CONTENT_LENGTH), truncated: true };
}

/** Read-only projection of user-visible gateway turns from Hermes SessionDB. */
export class HermesSqliteChannelHistorySource implements ChannelHistorySource {
  listThreads(hermesHome: string, channelId: string): SourceThread[] | null {
    let db: import('better-sqlite3').Database | null = null;
    try {
      db = new Database(join(hermesHome, 'state.db'), { readonly: true, fileMustExist: true });
      const sessions = db.prepare(`
        SELECT id, parent_session_id, started_at, title, display_name
        FROM sessions
        WHERE source = ?
        ORDER BY started_at, id
      `).all(channelId) as Array<{
        id: string;
        parent_session_id: string | null;
        started_at: number;
        title: string | null;
        display_name: string | null;
      }>;

      const mapped: SourceSession[] = sessions.map((session) => ({
        id: session.id,
        parentSessionId: session.parent_session_id,
        startedAt: session.started_at * 1_000,
        title: session.title,
        displayName: session.display_name,
      }));
      const byId = new Map(mapped.map((session) => [session.id, session]));
      const rootId = (session: SourceSession): string => {
        let current = session;
        const seen = new Set<string>();
        while (current.parentSessionId && byId.has(current.parentSessionId) && !seen.has(current.id)) {
          seen.add(current.id);
          current = byId.get(current.parentSessionId)!;
        }
        return current.id;
      };

      const groups = new Map<string, SourceSession[]>();
      for (const session of mapped) {
        const root = rootId(session);
        const group = groups.get(root) ?? [];
        group.push(session);
        groups.set(root, group);
      }

      const visibleMessages = db.prepare(`
        SELECT id, session_id, role, content, timestamp
        FROM messages
        WHERE session_id = ?
          AND active = 1
          AND role IN ('user', 'assistant')
          AND COALESCE(display_kind, '') != 'hidden'
        ORDER BY timestamp, id
      `);

      return [...groups.entries()].map(([rootSessionId, lineage]) => {
        const messages: SourceMessage[] = [];
        for (const session of lineage) {
          const rows = visibleMessages.all(session.id) as Array<{
            id: number;
            session_id: string;
            role: 'user' | 'assistant';
            content: string | null;
            timestamp: number;
          }>;
          for (const row of rows) {
            const safe = boundedContent(publicText(row.content));
            if (!safe.content) continue;
            messages.push({
              id: row.id,
              sessionId: row.session_id,
              role: row.role,
              content: safe.content,
              contentTruncated: safe.truncated,
              timestamp: row.timestamp * 1_000,
            });
          }
        }
        messages.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
        const tip = lineage.reduce((latest, session) => session.startedAt >= latest.startedAt ? session : latest);
        const titled = [...lineage].sort((a, b) => b.startedAt - a.startedAt)
          .find((session) => session.title?.trim() || session.displayName?.trim());
        return {
          rootSessionId,
          tipSessionId: tip.id,
          title: titled?.title?.trim() || titled?.displayName?.trim() || 'Conversation',
          messages,
          createdAt: Math.min(...lineage.map((session) => session.startedAt)),
          updatedAt: messages.at(-1)?.timestamp ?? tip.startedAt,
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}

export class ChannelHistoryBridge {
  constructor(
    private readonly db: DispatchDb,
    private readonly source: ChannelHistorySource,
  ) {}

  async listThreads(profileId: string, hermesHome: string, channelId: string): Promise<HermesChannelThreadsResult> {
    const sourceThreads = this.source.listThreads(hermesHome, channelId);
    if (sourceThreads === null) return { state: 'awaiting_bridge', threads: [] };

    const upsert = this.db.prepare(`
      INSERT INTO channel_threads (
        id, profile_id, channel_id, hermes_root_session_id, hermes_tip_session_id,
        title, preview, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, channel_id, hermes_root_session_id) DO UPDATE SET
        hermes_tip_session_id = excluded.hermes_tip_session_id,
        title = excluded.title,
        preview = excluded.preview,
        message_count = excluded.message_count,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    const threads = this.db.transaction(() => sourceThreads.map((sourceThread): HermesChannelThread => {
      const id = opaqueId('thread', profileId, channelId, sourceThread.rootSessionId);
      const preview = sourceThread.messages.at(-1)?.content ?? '';
      upsert.run(
        id, profileId, channelId, sourceThread.rootSessionId, sourceThread.tipSessionId,
        sourceThread.title, preview, sourceThread.messages.length,
        sourceThread.createdAt, sourceThread.updatedAt,
      );
      return {
        id,
        channelId,
        title: sourceThread.title,
        preview,
        messageCount: sourceThread.messages.length,
        createdAt: sourceThread.createdAt,
        updatedAt: sourceThread.updatedAt,
      };
    }))();

    return { state: 'available', threads };
  }

  async listMessages(
    profileId: string,
    hermesHome: string,
    channelId: string,
    threadId: string,
  ): Promise<HermesChannelMessagesResult | null> {
    const stored = this.db.prepare(`
      SELECT hermes_root_session_id
      FROM channel_threads
      WHERE id = ? AND profile_id = ? AND channel_id = ?
    `).get(threadId, profileId, channelId) as { hermes_root_session_id: string } | undefined;
    if (!stored) return null;

    const sourceThreads = this.source.listThreads(hermesHome, channelId);
    if (sourceThreads === null) return { state: 'awaiting_bridge', messages: [], truncated: false };
    const sourceThread = sourceThreads.find((thread) => thread.rootSessionId === stored.hermes_root_session_id);
    if (!sourceThread) return null;

    const selected = sourceThread.messages.slice(-MAX_MESSAGES);
    const truncated = selected.length < sourceThread.messages.length;
    const insert = this.db.prepare(`
      INSERT INTO channel_messages (
        id, thread_id, hermes_message_id, direction, content, content_truncated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, hermes_message_id) DO UPDATE SET
        direction = excluded.direction,
        content = excluded.content,
        content_truncated = excluded.content_truncated,
        created_at = excluded.created_at
    `);

    const messages = this.db.transaction(() => selected.map((message): HermesChannelMessage => {
      const id = opaqueId('message', threadId, message.sessionId, message.id);
      const direction = message.role === 'user' ? 'inbound' : 'outbound';
      insert.run(id, threadId, message.id, direction, message.content, Number(message.contentTruncated), message.timestamp);
      return {
        id,
        threadId,
        direction,
        content: message.content,
        contentTruncated: message.contentTruncated,
        createdAt: message.timestamp,
      };
    }))();

    return { state: 'available', messages, truncated };
  }
}
