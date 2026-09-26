import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OpenAIAuthResponse, OpenAIAuthSession } from '../../shared/openai-auth';
import { OpenAIAuthSettings } from '../../client/src/components/OpenAIAuthSettings';
import { RunFailureBanner } from '../../client/src/components/RunFailureBanner';
import { deriveRunFailureNotice } from '../../client/src/lib/runFailurePresentation';
import '../../client/src/styles/globals.css';

let scenario = 'waiting';
let session: OpenAIAuthSession | null = null;
const status: OpenAIAuthResponse['status'] = { provider: 'openai-codex', state: 'unknown', credentialScope: 'shared_default', checkedAt: null, code: null };
window.fetch = async (input, init) => {
  const url = new URL(String(input), window.location.origin);
  if (!url.pathname.startsWith('/api/agent/openai-auth') || url.searchParams.get('profile') !== 'som') throw new Error('Unexpected fixture request');
  if (url.pathname.endsWith('/start')) session = { sessionId: 'fixture-login', state: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'DEMO-1234', expiresAt: Date.now() + 600_000, pollIntervalMs: 1000, code: null };
  if (url.pathname.endsWith('/check')) status.state = scenario === 'unavailable' ? 'temporarily_unavailable' : scenario === 'saved' ? 'saved_login_ready' : 'reconnect_required';
  if (url.pathname.endsWith('/cancel') && session) session = { ...session, state: 'cancelled', userCode: null, verificationUrl: null };
  if (url.pathname.endsWith('/poll') && session) {
    const body = JSON.parse(String(init?.body));
    if (body.sessionId !== 'fixture-login') throw new Error('Wrong sign-in session');
    const state = ({ idle: 'waiting_for_idle', saved: 'saved', expired: 'expired' } as const)[scenario as 'idle' | 'saved' | 'expired'];
    if (state) session = { ...session, state, userCode: null, verificationUrl: null };
    if (state === 'saved') status.state = 'saved_login_ready';
  }
  return Response.json({ status, session });
};
function Fixture() {
  const [opened, setOpened] = useState(false);
  const [ready, setReady] = useState(false);
  const [continued, setContinued] = useState(false);
  const notice = deriveRunFailureNotice({ runId: 'fixture-run', taskId: 'fixture-task', kind: 'chat', status: 'error', errorCode: 'openai_auth_required', startedAt: 1, updatedAt: 2, completedAt: 2, modelResolution: null });
  return <main className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
    <h1 className="text-xl font-semibold">OpenAI sign-in · simulated responses</h1>
    <p className="text-sm text-zinc-500">The code is a fixture. No account, credential or model request is made.</p>
    <label className="block text-sm">Next poll / check response <select className="ml-2 rounded border p-2" onChange={event => { scenario = event.target.value; }}><option value="waiting">Waiting for user</option><option value="idle">Waiting for tasks</option><option value="saved">Saved</option><option value="expired">Expired</option><option value="unavailable">Temporarily unavailable</option></select></label>
    <RunFailureBanner notice={notice} authReady={ready} onOpenAIAuth={() => setOpened(true)} onContinue={() => setContinued(true)} />
    {opened && <OpenAIAuthSettings profileId="som" profileLabel="Som" initialScope="effective" onReady={() => setReady(true)} onNotReady={() => setReady(false)} />}
    {continued && <p role="status">Explicit Continue selected. The fixture does not send a task.</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
