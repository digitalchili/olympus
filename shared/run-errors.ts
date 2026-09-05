const INTERNAL_RUN_STOP_CODES = new Set([
  'iteration_limit',
  'run_idle_timeout',
  'run_runtime_timeout',
]);

const PERSISTED_RUN_ERROR_CODES = new Set([
  ...INTERNAL_RUN_STOP_CODES, 'agent_failed', 'worker_error', 'stream_incomplete',
  'session_persistence_failed', 'delegation_failed', 'delegation_incomplete',
  'worker_restarted', 'run_stopped', 'background_work_active',
]);

/** Persist only reviewed identifiers, never raw provider messages or secrets. */
export function safeRunErrorCode(code?: string | null): string {
  return code && PERSISTED_RUN_ERROR_CODES.has(code) ? code : 'agent_failed';
}

export function shouldAppendRunErrorToReply(code?: string): boolean {
  return !code || !INTERNAL_RUN_STOP_CODES.has(code);
}
