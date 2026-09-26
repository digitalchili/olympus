export type OpenAIAuthScope = 'shared' | 'profile';
export type OpenAIAuthState = 'unknown' | 'not_configured' | 'saved_login_ready'
  | 'reconnect_required' | 'temporarily_unavailable';

export interface OpenAIAuthStatus {
  provider: 'openai-codex';
  state: OpenAIAuthState;
  checkedAt: number | null;
  credentialScope: 'profile' | 'shared_default' | 'none' | 'unknown';
  code: string | null;
}

export interface OpenAIAuthSession {
  sessionId: string;
  state: 'starting' | 'awaiting_user' | 'waiting_for_idle' | 'saved' | 'cancelled' | 'expired' | 'failed';
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number | null;
  pollIntervalMs: number;
  code: string | null;
}

export type OpenAIAuthRequest = { action: 'status' | 'check' | 'start' }
  | { action: 'poll' | 'cancel'; sessionId: string };

export interface OpenAIAuthResponse {
  status: OpenAIAuthStatus;
  session: OpenAIAuthSession | null;
}

/** Private worker operations. HTTP callers cannot grant themselves a save guard. */
export type OpenAIAuthWorkerRequest = OpenAIAuthRequest
  | { action: 'commit'; sessionId: string }
  | { action: 'invalidate' }
  | { action: 'guard'; enabled: boolean };

export interface OpenAIAuthGuard { guarded: boolean; activeRuns: number }
