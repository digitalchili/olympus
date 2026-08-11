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
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  handling_profile_id TEXT,
  delegated_worker_id TEXT,
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

CREATE TABLE IF NOT EXISTS delegation_runs (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_session_id TEXT,
  parent_child_id TEXT,
  child_index INTEGER NOT NULL DEFAULT 0 CHECK(child_index >= 0),
  child_count INTEGER NOT NULL DEFAULT 1 CHECK(child_count >= 1),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'stalled', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown')),
  current_action TEXT,
  model TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_count >= 0),
  api_calls INTEGER NOT NULL DEFAULT 0 CHECK(api_calls >= 0),
  duration_seconds REAL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reasoning_tokens >= 0),
  cost_usd REAL,
  files_touched INTEGER NOT NULL DEFAULT 0 CHECK(files_touched >= 0),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(child_id)
);

CREATE INDEX IF NOT EXISTS idx_delegation_runs_task_time
  ON delegation_runs(task_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_delegation_runs_profile_time
  ON delegation_runs(profile_name, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_delegation_runs_status
  ON delegation_runs(status, updated_at DESC);

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

CREATE TABLE IF NOT EXISTS studio_github_connection_states (
  state_hash TEXT PRIMARY KEY,
  flow TEXT NOT NULL CHECK(flow IN ('manifest', 'install', 'oauth')),
  installation_id INTEGER,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK(
    (flow IN ('manifest', 'install') AND installation_id IS NULL)
    OR (flow = 'oauth' AND installation_id > 0)
  )
);

CREATE TABLE IF NOT EXISTS studio_github_installations (
  id INTEGER PRIMARY KEY CHECK(id > 0),
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('User', 'Organization')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_github_app_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  encrypted_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'github'),
  provider_repository_id INTEGER NOT NULL CHECK(provider_repository_id > 0),
  installation_id INTEGER NOT NULL CHECK(installation_id > 0) REFERENCES studio_github_installations(id),
  owner TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0, 1)),
  default_branch TEXT NOT NULL,
  html_url TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read_only' CHECK(mode = 'read_only'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, provider_repository_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_projects_updated
  ON studio_projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  name_key           TEXT NOT NULL UNIQUE,
  purpose            TEXT NOT NULL,
  manager_profile_id TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_updated
  ON projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS project_manager_history (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id     TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_to   INTEGER,
  changed_by     TEXT NOT NULL,
  CHECK(effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_manager_history_open
  ON project_manager_history(project_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_manager_history_project
  ON project_manager_history(project_id, effective_from);

CREATE TABLE IF NOT EXISTS project_profile_grants (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('view', 'contribute', 'manage')),
  granted_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY(project_id, profile_id)
);

CREATE TABLE IF NOT EXISTS project_repository_links (
  project_id             TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL CHECK(provider = 'github'),
  provider_repository_id INTEGER NOT NULL CHECK(provider_repository_id > 0),
  installation_id        INTEGER NOT NULL CHECK(installation_id > 0) REFERENCES studio_github_installations(id),
  owner                  TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  private                INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0, 1)),
  default_branch         TEXT NOT NULL,
  html_url               TEXT NOT NULL,
  clone_url              TEXT NOT NULL,
  mode                   TEXT NOT NULL DEFAULT 'read_only' CHECK(mode IN ('read_only', 'branch_pr')),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE(provider, provider_repository_id)
);

CREATE TABLE IF NOT EXISTS task_collaboration_grants (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  granted_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY(task_id, profile_id)
);

CREATE TABLE IF NOT EXISTS project_collaboration_grants (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  granted_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY(project_id, profile_id)
);

CREATE TABLE IF NOT EXISTS project_references (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  safe_filename     TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  extension         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256            TEXT NOT NULL,
  storage_path      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('uploaded', 'extracting', 'indexed', 'failed', 'deleted')),
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  indexed_at        INTEGER,
  deleted_at        INTEGER,
  UNIQUE(project_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_project_references_project
  ON project_references(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_reference_versions (
  id           TEXT PRIMARY KEY,
  reference_id TEXT NOT NULL REFERENCES project_references(id) ON DELETE CASCADE,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(reference_id, sha256)
);

CREATE TABLE IF NOT EXISTS project_reference_chunks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL REFERENCES project_references(id) ON DELETE CASCADE,
  version_id   TEXT NOT NULL REFERENCES project_reference_versions(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK(chunk_index >= 0),
  text         TEXT NOT NULL,
  page_number  INTEGER,
  sheet_name   TEXT,
  cell_range   TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(reference_id, chunk_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS project_reference_chunks_fts
  USING fts5(chunk_id UNINDEXED, project_id UNINDEXED, reference_id UNINDEXED, text);
