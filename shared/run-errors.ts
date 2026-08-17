const INTERNAL_RUN_STOP_CODES = new Set([
  'iteration_limit',
  'run_idle_timeout',
  'run_runtime_timeout',
]);

export function shouldAppendRunErrorToReply(code?: string): boolean {
  return !code || !INTERNAL_RUN_STOP_CODES.has(code);
}
