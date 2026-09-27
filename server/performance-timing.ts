import { randomUUID } from 'node:crypto';

const stages = new Set(['inventory', 'workspace', 'accepted', 'baseline', 'adapter_dispatch', 'first_activity', 'first_text', 'native_done', 'verification', 'artifacts']);
export type PerformanceStage = 'inventory' | 'workspace' | 'accepted' | 'baseline' | 'adapter_dispatch' | 'first_activity' | 'first_text' | 'native_done' | 'verification' | 'artifacts';
type Outcome = 'done' | 'error' | 'stopped' | 'rejected';
const outcomes = new Set<Outcome>(['done', 'error', 'stopped', 'rejected']);
const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const milliseconds = (value: number) => Math.round(Math.max(0, value) * 1000) / 1000;
const writeLog = (line: string) => console.error(line);

export interface PerformanceTrace {
  readonly id: string;
  bindRun(runId: string): void;
  mark(stage: PerformanceStage): void;
  span<T>(stage: PerformanceStage, work: () => Promise<T>): Promise<T>;
  finish(outcome: Outcome): void;
}

export function createPerformanceTrace(options: { clock?: () => number; write?: (line: string) => void } = {}): PerformanceTrace | null {
  if (process.env.OLYMPUS_PERF_DIAGNOSTICS !== '1') return null;
  const clock = options.clock ?? (() => performance.now());
  const write = options.write ?? writeLog;
  const id = randomUUID(), started = clock(), recorded = new Set<PerformanceStage>();
  let runId: string | undefined, finished = false;
  const emit = (record: object) => {
    try { write('[olympus-perf] ' + JSON.stringify({ source: 'node', traceId: id, ...(runId ? { runId } : {}), elapsedMs: milliseconds(clock() - started), ...record })); }
    catch { /* Optional diagnostics cannot fail task execution. */ }
  };
  const trace: PerformanceTrace = {
    id,
    bindRun(value) {
      if (finished || runId || !opaqueId(value)) return;
      runId = value;
      emit({ event: 'bound' });
    },
    mark(stage) {
      if (finished || !stages.has(stage) || recorded.has(stage)) return;
      recorded.add(stage);
      emit({ event: 'stage', stage });
    },
    async span(stage, work) {
      if (finished || !stages.has(stage) || recorded.has(stage)) return work();
      recorded.add(stage);
      const start = clock();
      try { return await work(); }
      finally { if (!finished) emit({ event: 'stage', stage, durationMs: milliseconds(clock() - start) }); }
    },
    finish(outcome) {
      // HTTP settlement only owns rejection; an accepted run outlives its 202.
      if (finished || !outcomes.has(outcome) || (outcome === 'rejected' && runId)) return;
      finished = true;
      emit({ event: 'finished', outcome });
    },
  };
  return trace;
}

export function requestPerformanceTrace(res: { locals: Record<string, any>; once(event: string, callback: () => void): unknown }): PerformanceTrace | null {
  if ('performanceTrace' in res.locals) return res.locals.performanceTrace;
  const trace = createPerformanceTrace();
  res.locals.performanceTrace = trace;
  if (trace) {
    res.once('finish', () => trace.finish('rejected'));
    res.once('close', () => trace.finish('rejected'));
  }
  return trace;
}

export function performanceSpan<T>(trace: PerformanceTrace | null | undefined, stage: PerformanceStage, work: () => Promise<T>): Promise<T> {
  return trace ? trace.span(stage, work) : work();
}

export function logWorkerDispatch(traceId: unknown, workerRequestId: string): void {
  if (process.env.OLYMPUS_PERF_DIAGNOSTICS !== '1' || !opaqueId(traceId) || !opaqueId(workerRequestId)) return;
  try { writeLog('[olympus-perf] ' + JSON.stringify({ source: 'adapter', event: 'dispatch', traceId, workerRequestId })); } catch { /* Best effort. */ }
}
