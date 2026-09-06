export const BOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_chains (
  id TEXT PRIMARY KEY,
  deadline_at INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_messages (
  id TEXT PRIMARY KEY,
  sender_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  recipient_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_profile_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  sender_label TEXT NOT NULL,
  recipient_label TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  chain_id TEXT NOT NULL REFERENCES bot_chains(id),
  depth INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('request', 'reply')),
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
  run_id TEXT,
  reply_to TEXT UNIQUE REFERENCES bot_messages(id) ON DELETE CASCADE,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_messages_dedup
  ON bot_messages(chain_id, sender_task_id, recipient_task_id, message) WHERE kind = 'request';
CREATE INDEX IF NOT EXISTS idx_bot_messages_pending ON bot_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_messages_recipient ON bot_messages(recipient_task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_messages_chain ON bot_messages(chain_id);
CREATE TABLE IF NOT EXISTS bot_run_contexts (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL REFERENCES bot_chains(id),
  depth INTEGER NOT NULL,
  delivery_id TEXT REFERENCES bot_messages(id) ON DELETE CASCADE
);
`;
