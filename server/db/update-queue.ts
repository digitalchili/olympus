import type { PendingUpdateRequest, PendingUpdateStore } from '../update-queue.js';

type DispatchDb = import('better-sqlite3').Database;

const PENDING_UPDATE_KEY = 'pending_update';

function parsePendingUpdate(value: string): PendingUpdateRequest | null {
  try {
    const parsed = JSON.parse(value) as Partial<PendingUpdateRequest>;
    if (
      typeof parsed.id !== 'string'
      || typeof parsed.repository !== 'string'
      || typeof parsed.currentVersion !== 'string'
      || typeof parsed.latestVersion !== 'string'
      || !(typeof parsed.releaseUrl === 'string' || parsed.releaseUrl === null)
      || typeof parsed.requestedAt !== 'number'
      || !Number.isFinite(parsed.requestedAt)
    ) return null;
    return parsed as PendingUpdateRequest;
  } catch {
    return null;
  }
}

export function createPendingUpdateStore(db: DispatchDb): PendingUpdateStore {
  const load = (): PendingUpdateRequest | null => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(PENDING_UPDATE_KEY) as { value: string } | undefined;
    return row ? parsePendingUpdate(row.value) : null;
  };

  return {
    load,
    saveIfEmpty(request) {
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(PENDING_UPDATE_KEY, JSON.stringify(request), request.requestedAt);
      const saved = load();
      if (!saved) throw new Error('The pending update request could not be persisted.');
      return saved;
    },
    remove(request) {
      if (load()?.id === request.id) {
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(PENDING_UPDATE_KEY);
      }
    },
  };
}
