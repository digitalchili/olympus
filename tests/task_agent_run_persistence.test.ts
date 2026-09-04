import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'olympus-agent-run-'));
process.env.DB_PATH = join(root, 'state.db');
process.env.OLYMPUS_DATA_DIR = root;

const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const {
  createTaskAgentRun,
  finishTaskAgentRun,
  getLatestTaskAgentRun,
  updateTaskAgentRunResolution,
} = await import('../server/db/task-agent-runs.js');

try {
  const task = insertTask({ title: 'Model resolution persistence', status: 'in_progress' });
  createTaskAgentRun({
    runId: 'run-1',
    taskId: task.id,
    kind: 'chat',
    status: 'streaming',
    startedAt: 100,
  });
  updateTaskAgentRunResolution('run-1', {
    requested: { model: 'gpt-6-astra', provider: 'openai-codex', reasoningEffort: 'xhigh' },
    actual: { model: 'gpt-5.5', provider: 'openai-codex', reasoningEffort: 'high' },
    fallbackReason: 'Primary model failed; Hermes activated its configured fallback.',
  }, 110);
  finishTaskAgentRun('run-1', 'done', 120);

  assert.deepEqual(getLatestTaskAgentRun(task.id), {
    runId: 'run-1',
    taskId: task.id,
    kind: 'chat',
    status: 'done',
    modelResolution: {
      requested: { model: 'gpt-6-astra', provider: 'openai-codex', reasoningEffort: 'xhigh' },
      actual: { model: 'gpt-5.5', provider: 'openai-codex', reasoningEffort: 'high' },
      fallbackReason: 'Primary model failed; Hermes activated its configured fallback.',
    },
    startedAt: 100,
    updatedAt: 120,
    completedAt: 120,
  });
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
