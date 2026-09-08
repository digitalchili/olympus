import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat, readlink, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import db from './db/index.js';
import { getTask } from './db/queries.js';
import type { Task } from '../shared/types.js';
import type { CodingEvidence, CodingCheck, RunningCodingCheck, SourceSnapshot } from '../shared/coding-evidence.js';

const exec = promisify(execFile);
const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
const WORKSPACE_CHANGED = 'This task’s workspace changed. Send a new message to establish its baseline before running checks.';
let shuttingDown = false;
export const isVerifying = (taskId: string): boolean => active.has(taskId);
export async function cancelCodingVerification(taskId: string, reason = 'Verification stopped by user'): Promise<boolean> {
  const verification = active.get(taskId);
  if (!verification) return false;
  verification.controller.abort(new Error(reason));
  await verification.done;
  return true;
}
/** Shutdown only: prevent later agent completions from starting another check. */
export async function cancelAllCodingVerifications(reason = 'Server shutting down'): Promise<void> {
  shuttingDown = true;
  await Promise.all([...active.keys()].map(taskId => cancelCodingVerification(taskId, reason)));
}
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await exec('git', args, { cwd, signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}
function redact(text: string): string {
  return text.replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
export async function sourceSnapshot(cwd: string, startingHead?: string, signal?: AbortSignal): Promise<SourceSnapshot> {
  const head = (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim();
  const files = [...new Set((await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256').update(head);
  for (const file of files) {
    signal?.throwIfAborted();
    hash.update('\0' + file + '\0');
    try {
      const info = await lstat(join(cwd, file));
      hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(await readlink(join(cwd, file)));
      else if (info.isFile()) for await (const chunk of createReadStream(join(cwd, file), { signal })) hash.update(chunk);
      else throw new Error('Nested repositories need explicit verification in their own task');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted');
      else throw error;
    }
  }
  const comparedHead = startingHead ?? head;
  const untracked = (await git(cwd, ['status', '--porcelain', '--untracked-files=all'], signal)).split('\n').filter(line => line.startsWith('?? '));
  const changedFiles = [...(await git(cwd, ['diff', '--name-status', comparedHead, '--'], signal)).trim().split('\n').filter(Boolean), ...untracked];
  const diff = redact(await git(cwd, ['diff', comparedHead, '--'], signal)).slice(0, 256_000);
  return { head, fingerprint: hash.digest('hex'), changedFiles, diff };
}
function save(evidence: CodingEvidence): void {
  db.prepare(`INSERT INTO coding_evidence VALUES (?, ?, ?, ?) ON CONFLICT(task_id, run_id)
    DO UPDATE SET evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`)
    .run(evidence.taskId, evidence.runId, JSON.stringify(evidence), evidence.updatedAt);
}
function read(taskId: string, runId?: string): CodingEvidence | null {
  const row = (runId ? db.prepare('SELECT evidence_json FROM coding_evidence WHERE task_id=? AND run_id=?').get(taskId, runId)
    : db.prepare('SELECT evidence_json FROM coding_evidence WHERE task_id=? ORDER BY updated_at DESC LIMIT 1').get(taskId)) as { evidence_json: string } | undefined;
  return row ? JSON.parse(row.evidence_json) : null;
}
export async function captureCodingBaseline(task: Task, runId: string, signal?: AbortSignal): Promise<void> {
  task = getTask(task.id) ?? task;
  if (!task.workdir || read(task.id, runId)) return;
  let workdir: string;
  try { workdir = await realpath((await git(task.workdir, ['rev-parse', '--show-toplevel'], signal)).trim()); }
  catch (error) { signal?.throwIfAborted(); return; }
  const baseline = await sourceSnapshot(workdir, undefined, signal);
  save({ taskId: task.id, runId, workdir, taskWorkdir: task.workdir, status: 'pending', baseline, source: null, checks: [], reason: null, updatedAt: Date.now() });
}
async function commands(cwd: string): Promise<string[][]> {
  try {
    const value = JSON.parse(await readFile(join(cwd, '.olympus/verification.json'), 'utf8')) as { commands?: unknown };
    if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 8 || !value.commands.every(c => Array.isArray(c) && c.length > 0 && c.length < 32 && c.every(a => typeof a === 'string' && a.length > 0 && a.length <= 4000))) throw new Error('Verification config requires 1–8 nonempty command argument arrays');
    return value.commands as string[][];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return ['test', 'typecheck', 'build'].filter(name => typeof pkg.scripts?.[name] === 'string').map(name => ['npm', 'run', name]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function runCheck(cwd: string, command: string[], timeoutMs: number, signal: AbortSignal, onProgress: (check: RunningCodingCheck) => void): Promise<CodingCheck> {
  signal.throwIfAborted();
  const start = Date.now();
  return await new Promise(resolve => {
    let output = ''; let timedOut = false; let finished = false;
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    const finish = (exitCode: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer); clearInterval(progressTimer); signal.removeEventListener('abort', abort);
      resolve({ command, exitCode, output: redact(output), durationMs: Date.now() - start, timedOut });
    };
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const abort = () => { timedOut = signal.reason?.name === 'TimeoutError'; output += '\nVerification cancelled.'; kill(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      output += '\nVerification command exceeded its time budget.';
      kill();
    }, Math.max(1, timeoutMs));
    let lastProgress = 0;
    const publishProgress = () => {
      lastProgress = Date.now();
      onProgress({ command, output: redact(output), startedAt: start, durationMs: lastProgress - start });
    };
    // Persist bounded output while the process runs, plus a heartbeat for quiet
    // commands. Throttle noisy processes so output cannot flood SQLite.
    const progressTimer = setInterval(publishProgress, 1000);
    publishProgress();
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64_000);
      if (Date.now() - lastProgress >= 250) publishProgress();
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { output += error.message; finish(null); });
    child.on('close', code => finish(code));
  });
}
export async function verifyCodingRun(task: Task, runId: string, timeoutMs = 5 * 60_000, options: { skipUnchanged?: boolean } = {}): Promise<boolean> {
  if (active.has(task.id) || shuttingDown) return false;
  const controller = new AbortController();
  const signal = controller.signal;
  let settled!: () => void;
  active.set(task.id, { controller, done: new Promise<void>(resolve => { settled = resolve; }) });
  let evidence: CodingEvidence | null = null;
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const timer = setTimeout(() => controller.abort(new DOMException('Verification budget exhausted', 'TimeoutError')), Math.max(1, timeoutMs));
  try {
    evidence = read(task.id, runId);
    const currentTask = getTask(task.id);
    if (!currentTask) return false;
    task = currentTask;
    const hadBaseline = evidence !== null;
    // A run may have created its repository after the initial baseline probe.
    if (!evidence) { await captureCodingBaseline(task, runId, signal); evidence = read(task.id, runId); }
    signal.throwIfAborted();
    if (!evidence) return true;
    if (!task.workdir) { evidence.status = 'stale'; evidence.reason = WORKSPACE_CHANGED; return false; }
    const workdir = await realpath((await git(task.workdir, ['rev-parse', '--show-toplevel'], signal)).trim());
    if (workdir !== evidence.workdir) { evidence.status = 'stale'; evidence.reason = WORKSPACE_CHANGED; return false; }
    evidence.taskWorkdir = task.workdir;
    evidence.currentCheck = null;
    evidence.source = await sourceSnapshot(workdir, evidence.baseline.head, signal);
    // Only automatic, non-coding turns can skip. A repository created during
    // the turn has no starting snapshot and must still be verified.
    if (options.skipUnchanged && hadBaseline && evidence.source.fingerprint === evidence.baseline.fingerprint) {
      evidence.status = 'skipped'; evidence.checks = [];
      evidence.reason = 'No repository changes or verification request in this turn. Checks were not run.';
      return true;
    }
    evidence.status = 'running'; evidence.checks = []; evidence.reason = null; evidence.updatedAt = Date.now(); save(evidence);
    const required = await commands(workdir);
    if (!required.length) { evidence.status = 'unconfigured'; evidence.reason = 'Configure .olympus/verification.json with the checks required for this project.'; return false; }
    for (const command of required) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) { evidence.status = 'failed'; evidence.reason = 'Verification budget exhausted'; return false; }
      const result = await runCheck(workdir, command, deadline - Date.now(), signal, check => {
        evidence!.currentCheck = check; evidence!.updatedAt = Date.now(); save(evidence!);
      });
      evidence.currentCheck = null;
      evidence.checks.push(result); evidence.updatedAt = Date.now(); save(evidence);
      signal.throwIfAborted();
      if (result.exitCode !== 0 || result.timedOut) { evidence.status = 'failed'; evidence.reason = 'A required verification command failed'; return false; }
    }
    if (getTask(task.id)?.workdir !== task.workdir) { evidence.status = 'stale'; evidence.reason = WORKSPACE_CHANGED; return false; }
    if ((await sourceSnapshot(workdir, undefined, signal)).fingerprint !== evidence.source.fingerprint) { evidence.status = 'stale'; evidence.reason = 'Source changed during verification. Run checks again.'; return false; }
    evidence.status = 'passed'; return true;
  } catch (error) {
    if (!evidence) throw error;
    evidence.status = 'failed'; evidence.reason = redact(error instanceof Error ? error.message : 'Verification failed'); return false;
  } finally {
    clearTimeout(timer);
    try { if (evidence) { evidence.currentCheck = null; evidence.updatedAt = Date.now(); save(evidence); } }
    finally { active.delete(task.id); settled(); }
  }
}
export async function readCodingEvidence(task: Task): Promise<CodingEvidence | null> {
  const evidence = read(task.id);
  if (evidence && evidence.status !== 'running') {
    const previousStatus = evidence.status;
    try {
      const currentTask = getTask(task.id);
      const workdir = currentTask?.workdir ? await realpath((await git(currentTask.workdir, ['rev-parse', '--show-toplevel'])).trim()) : null;
      if (!workdir || workdir !== evidence.workdir) { evidence.status = 'stale'; evidence.reason = WORKSPACE_CHANGED; }
      else if (evidence.source && evidence.status === 'passed' && (await sourceSnapshot(workdir)).fingerprint !== evidence.source.fingerprint) {
        evidence.status = 'stale'; evidence.reason = 'Source changed or is unavailable. Run checks again.';
      }
    } catch { evidence.status = 'stale'; evidence.reason = 'The task workspace is unavailable. Restore it or send a new message before running checks.'; }
    if (evidence.status === 'stale') {
      // Do not overwrite a newer manual verification that started during the scan.
      const current = read(task.id);
      if (current?.runId === evidence.runId && current.status === previousStatus && current.updatedAt === evidence.updatedAt) {
        evidence.updatedAt = Date.now(); save(evidence);
      }
    }
  }
  return evidence;
}

export function codingReviewAllowed(taskId: string, runId: string): boolean {
  const evidence = read(taskId, runId);
  // verifyCodingRun checks source freshness under its deadline before emitting
  // done. Do not start another, uncancellable source scan after terminal delivery.
  if (!evidence) return true;
  const workdir = getTask(taskId)?.workdir;
  return evidence.status === 'passed' && evidence.source !== null && Boolean(workdir)
    && (evidence.taskWorkdir ?? evidence.workdir) === workdir;
}
