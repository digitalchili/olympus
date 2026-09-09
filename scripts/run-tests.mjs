import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pythonTests = [
  'test_hermes_worker_resolve.py',
  'test_hermes_sessions_pagination.py',
  'test_delegation_event_projection.py',
  'test_worker_environment_overrides.py',
  'test_worker_usage.py',
  'test_worker_providers.py',
  'test_worker_task_workdir.py',
  'test_worker_background_work_rpc.py',
  'test_worker_deadline_budget.py',
  'test_worker_recovery.py',
  'test_background_work_native.py',
  'test_scheduled_task_drain.py',
  'hermes_worker_interactions_test.py',
  'test_bot_messaging.py',
];
const selected = process.argv.slice(2);
const tests = selected.length ? selected : [
  ...pythonTests.map((name) => join('tests', name)),
  ...(await readdir('tests')).filter((name) => name.endsWith('.test.ts')).sort().map((name) => join('tests', name)),
];

for (const file of tests) {
  const root = await mkdtemp(join(tmpdir(), 'olympus-test-run-'));
  const state = join(root, 'state');
  const hermes = join(root, 'hermes');
  const projects = join(root, 'projects');
  try {
    await Promise.all([state, hermes, projects].map((path) => mkdir(path, { recursive: true })));
    const python = file.endsWith('.py');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(python ? 'python3' : process.execPath, python ? [file] : ['--import', 'tsx', file], {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TSX_TSCONFIG_PATH: 'client/tsconfig.json',
          OLYMPUS_DISPATCH_HOME: state,
          HERMES_HOME: hermes,
          OLYMPUS_DISPATCH_PROJECT_ROOT: projects,
          DB_PATH: join(state, 'test.db'),
        },
      });
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
