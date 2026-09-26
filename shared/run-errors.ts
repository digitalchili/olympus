const INTERNAL_RUN_STOP_CODES = new Set([
  'iteration_limit',
  'run_idle_timeout',
  'run_runtime_timeout',
  'deadline_finalized',
]);

const PERSISTED_RUN_ERROR_CODES = new Set([
  'openai_auth_required', 'openai_auth_unavailable', 'auth_busy',
  'auth_error', 'rate_limit', 'quota_exhausted', 'model_error', 'provider_error',
  ...INTERNAL_RUN_STOP_CODES, 'agent_failed', 'worker_error', 'stream_incomplete',
  'session_persistence_failed', 'delegation_failed', 'delegation_incomplete',
  'recovery_pending', 'recovery_blocked', 'goal_incomplete', 'verification_failed', 'recovery_exhausted', 'worker_restarted', 'run_stopped', 'background_work_active',
]);

const PROVIDER_MESSAGES: Record<string, string> = {
  openai_auth_required: 'OpenAI sign-in required. Reconnect OpenAI in Olympus.',
  openai_auth_unavailable: 'OpenAI connection temporarily unavailable. Check the saved login in Olympus.',
  auth_error: 'Provider sign-in or key required. Open provider settings.',
  rate_limit: 'Provider rate limit reached. View usage, wait, or choose another model or provider.',
  quota_exhausted: 'Provider allowance unavailable. View usage or open provider settings.',
  model_error: 'Selected model is unavailable. Choose another model.',
  provider_error: 'The provider could not complete this run. Review saved progress before continuing.',
};

export function safeProviderErrorMessage(code?: string | null): string | undefined {
  return code ? PROVIDER_MESSAGES[code] : undefined;
}

/** Persist only reviewed identifiers, never raw provider messages or secrets. */
export function safeRunErrorCode(code?: string | null): string {
  return code && PERSISTED_RUN_ERROR_CODES.has(code) ? code : 'agent_failed';
}

export function shouldAppendRunErrorToReply(code?: string): boolean {
  return !code || !INTERNAL_RUN_STOP_CODES.has(code);
}
