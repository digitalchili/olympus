import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Task } from '../shared/types.js';
import type { ProjectRunRequest, ProjectRunRespondRequest } from './adapters/types.js';
import { getTask } from './db/queries.js';
import { getProjectSecretValues, listProjectSecrets } from './db/project-secrets.js';
import { canProfileAccessProject, requireProfileProjectAccess } from './project-access.js';
import { untilStopped } from './run-cancellation.js';

const OUTPUT_LIMIT = 256_000;
const safeEnvironmentNames = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'USER', 'LOGNAME'];
type Result = ProjectRunRespondRequest['result'];
const unavailable = (): Result => ({ ok: false, error: 'Project command unavailable. Check saved secrets, access and task status.' });

/** Names only. Credentials never enter agent options, prompts or worker requests. */
export function projectSecretNamesForTask(task: Task): string[] {
  if (task.kind === 'bot' || !task.project_id || !task.workdir
    || !canProfileAccessProject(task.project_id, task.profile_name ?? 'default', 'contribute')) return [];
  return listProjectSecrets(task.project_id).map(secret => secret.name);
}

function redactionVariants(values: Record<string, string>): string[] {
  const variants = new Set<string>();
  for (const secret of Object.values(values)) {
    const parts = [secret];
    try {
      const password = new URL(secret).password;
      if (password) parts.push(password, decodeURIComponent(password));
    } catch { /* Most keys are not URLs. */ }
    for (const value of parts) {
      if (!value) continue;
      variants.add(value);
      variants.add(JSON.stringify(value).slice(1, -1));
      variants.add(encodeURIComponent(value));
      variants.add(Buffer.from(value).toString('base64'));
      variants.add(Buffer.from(value).toString('base64url'));
    }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/** Redact before model/history exposure, preserving enough raw lookahead at the capture boundary. */
function redactOutput(output: string, variants: string[], truncated: boolean): { output: string; truncated: boolean } {
  if (!variants.length) return { output, truncated };
  const cutoff = truncated ? Math.max(0, output.length - Math.max(...variants.map(value => value.length))) : output.length;
  const pattern = new RegExp(variants.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  let cursor = 0;
  let safe = '';
  for (const match of output.matchAll(pattern)) {
    if (match.index >= cutoff) break;
    safe += output.slice(cursor, match.index) + '[redacted]';
    cursor = match.index + match[0].length;
  }
  if (cursor < cutoff) safe += output.slice(cursor, cutoff);
  return { output: safe.slice(0, OUTPUT_LIMIT), truncated: truncated || safe.length > OUTPUT_LIMIT };
}

/** Trusted local execution, not a sandbox for hostile code; no persistent plaintext files. */
export function runProjectCommand(command: string, cwd: string, values: Record<string, string>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.resolve(unavailable());
  const variants = redactionVariants(values);
  const env = Object.fromEntries(safeEnvironmentNames.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  Object.assign(env, values);
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stdout = { chunks: [] as Buffer[], truncated: false };
    const stderr = { chunks: [] as Buffer[], truncated: false };
    let captured = 0;
    let failed = false;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process group has already exited. */ }
    };
    const capture = (stream: typeof stdout, chunk: Buffer) => {
      if (captured + chunk.length > OUTPUT_LIMIT) stream.truncated = true;
      const keep = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - captured));
      if (keep.length) stream.chunks.push(keep);
      captured += keep.length;
      // Continue draining noisy output. Output size never terminates a task.
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.on('error', () => { failed = true; });
    // A foreground command cannot leave same-group helpers running after its shell exits.
    child.on('exit', stop);
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      if (failed || signal.aborted || code === null) { resolve(unavailable()); return; }
      try {
        // Separate streams prevent interleaved stderr from splitting a stdout secret match.
        const clean = [stdout, stderr].map(stream => redactOutput(Buffer.concat(stream.chunks).toString('utf8'), variants, stream.truncated));
        const output = clean.map(stream => stream.output).filter(Boolean).join('\n');
        resolve({ ok: true, exitCode: code, output: output.slice(0, OUTPUT_LIMIT),
          truncated: clean.some(stream => stream.truncated) || output.length > OUTPUT_LIMIT });
      } catch { resolve(unavailable()); }
    });
  });
}

export function createProjectSecretsRuntime(options: {
  values?: typeof getProjectSecretValues;
  run?: typeof runProjectCommand;
} = {}) {
  const valuesFor = options.values ?? getProjectSecretValues;
  const run = options.run ?? runProjectCommand;
  return {
    async execute(task: Task, request: ProjectRunRequest, active: () => boolean): Promise<Result> {
      const controller = new AbortController();
      let operation: Promise<Result> | undefined;
      const assertAccess = () => {
        const current = getTask(task.id);
        if (!active() || controller.signal.aborted || !current?.project_id || current.kind === 'bot'
          || current.project_id !== task.project_id || current.profile_name !== task.profile_name
          || current.workdir !== task.workdir || !current.workdir || !isAbsolute(current.workdir)) throw new Error('Task changed');
        requireProfileProjectAccess(current.project_id, current.profile_name ?? 'default', 'contribute');
        return current;
      };
      try {
        const current = assertAccess();
        if (typeof request.command !== 'string' || !request.command.trim() || request.command.length > 20_000 || request.command.includes('\0')
          || !Array.isArray(request.secrets) || request.secrets.length < 1 || request.secrets.length > 64
          || request.secrets.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
          || new Set(request.secrets).size !== request.secrets.length) return unavailable();
        const cwd = await realpath(current.workdir!);
        assertAccess();
        const values = valuesFor(current.project_id!, request.secrets);
        if (request.secrets.some(name => !Object.hasOwn(values, name))) return unavailable();
        operation = run(request.command, cwd, values, controller.signal);
        const result = await untilStopped(() => operation!, () => {
          try { assertAccess(); return false; } catch { return true; }
        });
        assertAccess();
        return result;
      } catch {
        controller.abort();
        await operation?.catch(() => {});
        return unavailable();
      }
    },
  };
}

export const projectSecretsRuntime = createProjectSecretsRuntime();
