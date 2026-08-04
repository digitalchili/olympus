CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'in_progress',
  profile_name      TEXT,
  routing_source    TEXT,
  agent_model       TEXT,
  agent_provider    TEXT,
  reasoning_effort  TEXT,
  workdir           TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_agent_response_at  INTEGER,
  last_viewed_at    INTEGER,
  last_context_used_tokens   INTEGER,
  last_context_window_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS collaboration_runs (
  id                        TEXT PRIMARY KEY,
  task_id                   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round                     INTEGER NOT NULL,
  status                    TEXT NOT NULL,
  question                  TEXT NOT NULL,
  owner_profile_id          TEXT NOT NULL,
  owner_invited             INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  contributors_completed_at INTEGER,
  completed_at              INTEGER,
  UNIQUE(task_id, round)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_runs_task
  ON collaboration_runs(task_id, round DESC);

CREATE TABLE IF NOT EXISTS collaboration_contributions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
  profile_id    TEXT NOT NULL,
  profile_label TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  phase         TEXT NOT NULL,
  phase_round   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  content       TEXT,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  UNIQUE(run_id, profile_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_contributions_run
  ON collaboration_contributions(run_id, started_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_threads (
  id                     TEXT PRIMARY KEY,
  profile_id             TEXT NOT NULL,
  channel_id             TEXT NOT NULL,
  hermes_root_session_id TEXT NOT NULL,
  hermes_tip_session_id  TEXT NOT NULL,
  title                  TEXT NOT NULL,
  preview                TEXT NOT NULL,
  message_count          INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE(profile_id, channel_id, hermes_root_session_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_threads_profile_channel
  ON channel_threads(profile_id, channel_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_messages (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL REFERENCES channel_threads(id) ON DELETE CASCADE,
  hermes_message_id   INTEGER NOT NULL,
  direction           TEXT NOT NULL,
  content             TEXT NOT NULL,
  content_truncated   INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  UNIQUE(thread_id, hermes_message_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
  ON channel_messages(thread_id, created_at, hermes_message_id);
