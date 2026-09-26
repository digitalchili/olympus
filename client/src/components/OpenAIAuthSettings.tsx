import { useEffect, useRef, useState } from 'react';
import type { OpenAIAuthRequest, OpenAIAuthResponse, OpenAIAuthScope, OpenAIAuthSession } from '@shared/openai-auth';
import { DEFAULT_PROFILE_NAME } from '@shared/types';
import { manageOpenAIAuth } from '../lib/api';

const DEVICE_URL = 'https://auth.openai.com/codex/device';
const buttonClass = 'rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900';
const statusText = {
  unknown: 'Saved login not checked.',
  not_configured: 'No OpenAI login is saved for this scope.',
  saved_login_ready: 'Saved OpenAI login is ready.',
  reconnect_required: 'The saved OpenAI login needs to be reconnected.',
  temporarily_unavailable: 'OpenAI login is temporarily unavailable. Try checking again later.',
};
const activeSession = (session: OpenAIAuthSession | null) => session && ['starting', 'awaiting_user', 'waiting_for_idle'].includes(session.state);

export function OpenAIAuthSettings({ profileId, profileLabel, initialScope = 'shared', onReady, onNotReady }: {
  profileId: string; profileLabel: string; initialScope?: 'shared' | 'effective'; onReady?: () => void; onNotReady?: () => void;
}) {
  const [scope, setScope] = useState<OpenAIAuthScope | 'effective' | 'choose'>(initialScope);
  const [scopeLocked, setScopeLocked] = useState(false);
  const [response, setResponse] = useState<OpenAIAuthResponse | null>(null);
  const [busy, setBusy] = useState('status');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const notReadyRef = useRef(onNotReady);
  notReadyRef.current = onNotReady;
  const previousProfileRef = useRef(profileId);
  const actionRef = useRef<(input: OpenAIAuthRequest) => void>(() => {});

  useEffect(() => {
    let alive = true;
    let version = 0;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let currentSession: OpenAIAuthSession | null = null;
    if (previousProfileRef.current !== profileId) notReadyRef.current?.();
    previousProfileRef.current = profileId;
    setResponse(null); setError(''); setCopied(false); setBusy(scope === 'choose' ? '' : 'status');
    actionRef.current = () => {};
    if (scope === 'choose') return;

    if (scope === 'effective') {
      notReadyRef.current?.();
      // A task reconnect first preserves any login owned by its execution profile.
      void (async () => {
        try {
          let result = await manageOpenAIAuth(profileId, { action: 'status' }, 'profile');
          if (!alive) return;
          let checked = false;
          if (result.status.credentialScope === 'unknown') {
            result = await manageOpenAIAuth(profileId, { action: 'check' }, 'profile');
            checked = true;
          }
          if (!alive) return;
          const owner = result.status.credentialScope;
          setScopeLocked(owner !== 'unknown');
          setScope(owner === 'profile' ? 'profile' : owner === 'shared_default' || owner === 'none' ? 'shared' : 'choose');
          if (checked && result.status.state === 'saved_login_ready' && owner !== 'unknown') readyRef.current?.();
        } catch { if (alive) setScope('choose'); }
      })();
      return () => { alive = false; };
    }

    const perform = async (input: OpenAIAuthRequest) => {
      if (!alive || (pending && input.action !== 'cancel')) return;
      const requestVersion = ++version;
      pending = true;
      clearTimeout(timer);
      if (input.action === 'check' || input.action === 'start' || input.action === 'cancel') notReadyRef.current?.();
      setBusy(input.action); setError(''); setCopied(false);
      try {
        const result = await manageOpenAIAuth(profileId, input, scope);
        if (!alive || version !== requestVersion) return;
        currentSession = activeSession(result.session) ? result.session : null;
        setResponse(result);
        if (result.session && ['failed', 'expired', 'cancelled'].includes(result.session.state)) notReadyRef.current?.();
        if (input.action !== 'status' && result.status.state === 'saved_login_ready'
          && (result.session?.state === 'saved' || input.action === 'check')) {
          // Shared login can be valid while this task has a separate, invalid login.
          // Verify the effective profile before enabling its explicit Continue action.
          let effectiveReady = true;
          if (initialScope === 'effective' && scope === 'shared') {
            const effective = await manageOpenAIAuth(profileId, { action: 'check' }, 'profile');
            if (!alive || version !== requestVersion) return;
            effectiveReady = effective.status.state === 'saved_login_ready';
            if (!effectiveReady) {
              notReadyRef.current?.();
              setError('The login used by this task still needs attention. Check the profile login before continuing.');
              if (effective.status.credentialScope === 'profile') { setScope('profile'); setScopeLocked(true); }
            }
          }
          if (effectiveReady) readyRef.current?.();
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('olympus:models-changed'));
        }
        if (currentSession) {
          const sessionId = currentSession.sessionId;
          const delay = Number.isFinite(currentSession.pollIntervalMs) ? Math.max(1000, currentSession.pollIntervalMs) : 5000;
          timer = setTimeout(() => { void perform({ action: 'poll', sessionId }); }, delay);
        }
      } catch {
        if (alive && version === requestVersion) { notReadyRef.current?.(); setError('Could not check OpenAI sign-in. Try again.'); }
      } finally {
        if (alive && version === requestVersion) { pending = false; setBusy(''); }
      }
    };
    actionRef.current = input => { void perform(input); };
    void perform({ action: 'status' });
    return () => {
      alive = false; version++; clearTimeout(timer);
      // The attempt survives navigation and can be recovered by the next status read.
    };
  }, [profileId, scope, initialScope]);

  const session = response?.session ?? null;
  const active = Boolean(activeSession(session));
  const choosing = scope === 'choose' || scope === 'effective';
  const canShowCode = active && session?.state === 'awaiting_user' && session.verificationUrl === DEVICE_URL;
  return <section aria-label="OpenAI sign-in" className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900 sm:p-5">
    <h3 className="font-semibold">OpenAI sign-in</h3>
    <p className="text-zinc-500">The shared login is used by all profiles unless a profile has its own login. Signing in here does not change your model.</p>
    {profileId !== DEFAULT_PROFILE_NAME && <label className="block space-y-1">
      <span className="font-medium">Login to manage</span>
      <select className="block w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700" value={choosing ? '' : scope} disabled={!!busy || active || scopeLocked} onChange={event => { notReadyRef.current?.(); setScope(event.target.value as OpenAIAuthScope); }}>
        {choosing && <option value="" disabled>Choose which login to manage</option>}
        <option value="shared">Shared login · all inheriting profiles</option>
        <option value="profile">Separate login · {profileLabel} only</option>
      </select>
    </label>}
    {scope === 'profile' && <p className="text-zinc-500">This manages {profileLabel}’s own login. Other profiles keep their existing login.</p>}
    {scope === 'choose' && <p role="status">Choose which login to manage. We could not confirm whether this profile has a separate login.</p>}
    {scope === 'choose' && profileId === DEFAULT_PROFILE_NAME && <button type="button" className={buttonClass} onClick={() => setScope('shared')}>Manage shared login</button>}
    <p role="status">{busy === 'status' ? (scope === 'effective' ? 'Finding the login used by this task…' : 'Loading saved login status…') : busy === 'check' ? 'Checking saved login…' : response ? statusText[response.status.state] : ''}</p>
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    {active && session?.state === 'starting' && <p role="status">Preparing OpenAI sign-in…</p>}
    {canShowCode && <div className="space-y-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
      <p>Open OpenAI in a new tab and enter this code. Keep this page open while you sign in.</p>
      <div className="flex flex-wrap items-center gap-3"><code className="break-all text-lg font-semibold tracking-wider">{session.userCode}</code><button type="button" className="underline" onClick={() => {
        void (async () => {
          try { await navigator.clipboard.writeText(session.userCode ?? ''); setCopied(true); }
          catch { setError('Could not copy the code. Select and copy it manually.'); }
        })();
      }}>{copied ? 'Copied' : 'Copy code'}</button></div>
      <a className="inline-block font-medium underline" href={DEVICE_URL} target="_blank" rel="noopener noreferrer">Open OpenAI sign-in</a>
      {session.expiresAt && <p className="text-xs text-zinc-500">Code expires at {new Date(session.expiresAt).toLocaleTimeString()}.</p>}
    </div>}
    {active && session?.state === 'awaiting_user' && !canShowCode && <p role="alert">The sign-in link could not be verified. Cancel and try again.</p>}
    {session?.state === 'waiting_for_idle' && <p role="status">OpenAI approved the sign-in. Waiting for affected tasks to finish before saving it. Your running tasks will continue.</p>}
    {session?.state === 'saved' && response?.status.state === 'saved_login_ready' && <p role="status" className="text-emerald-700 dark:text-emerald-400">OpenAI login saved. You can continue the task when you are ready.</p>}
    {session?.state === 'cancelled' && <p role="status">Sign-in cancelled. The saved login is unchanged.</p>}
    {session?.state === 'expired' && <p role="status">This sign-in code expired. Start again for a new code.</p>}
    {session?.state === 'failed' && (session.code === 'auth_storage_failed'
      ? response?.status.state !== 'saved_login_ready' && <p role="alert">Saving the login could not be confirmed. OpenAI may already be connected. Use Check saved login before trying again.</p>
      : <p role="alert">{session.code === 'auth_account_mismatch'
        ? 'Sign in with the same OpenAI account and workspace previously used for this login. The saved login is unchanged.'
        : session.code === 'auth_unsupported'
          ? 'This Hermes installation or its advanced OpenAI credentials are not supported by this sign-in flow. Manage the login in Hermes.'
          : 'OpenAI sign-in could not be completed. The saved login is unchanged. Try again.'}</p>)}
    {!choosing && <div className="flex flex-wrap items-center gap-3">
      {!active && <><button type="button" className={buttonClass} disabled={!!busy} onClick={() => actionRef.current({ action: 'start' })}>{busy === 'start' ? 'Starting sign-in…' : 'Sign in to OpenAI'}</button><button type="button" className="underline disabled:opacity-40" disabled={!!busy} onClick={() => actionRef.current({ action: 'check' })}>Check saved login</button></>}
      {active && session && <><button type="button" className="underline disabled:opacity-40" disabled={busy === 'cancel'} onClick={() => actionRef.current({ action: 'cancel', sessionId: session.sessionId })}>Cancel sign-in</button>{error && <button type="button" className="underline disabled:opacity-40" disabled={!!busy} onClick={() => actionRef.current({ action: 'poll', sessionId: session.sessionId })}>Check sign-in</button>}</>}
    </div>}
  </section>;
}
