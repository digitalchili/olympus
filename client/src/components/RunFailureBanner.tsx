import type { RecoveryWaitReason } from '@shared/types';
import { isRecovering, isOpenAIAuthAction, type RunFailureNotice } from '../lib/runFailurePresentation';

export function RunFailureBanner({ notice, recoveryState, recoveryWaitReason, onContinue, onPause, onOpenAIAuth, onAction, onSendQueued, authReady = false, authBusy = false, busy = false }: {
  notice: RunFailureNotice | null; recoveryState?: string | null; recoveryWaitReason?: RecoveryWaitReason | null;
  onContinue?: () => void; onPause?: () => void; busy?: boolean;
  onOpenAIAuth?: () => void; authReady?: boolean; authBusy?: boolean;
  onAction?: (action: RunFailureNotice['action']) => void; onSendQueued?: () => void;
}) {
  if (!notice) return null;
  const openAI = isOpenAIAuthAction(notice.action);
  const needsAuth = openAI && !authReady;
  const recovering = notice.action === 'continue' && isRecovering(recoveryState);
  const waiting = recoveryWaitReason === 'queued_message' || recoveryWaitReason === 'awaiting_input';
  const actionLabels = { provider_settings: 'Open provider settings', usage: 'View usage', model_picker: 'Choose model' };
  const actionLabel = notice.action in actionLabels ? actionLabels[notice.action as keyof typeof actionLabels] : null;
  const buttonClass = 'mt-3 rounded-md bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900';
  return (
    <div className="w-full min-w-0 max-w-[760px] mx-auto mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 shadow-sm dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100" role="status">
      <div className="font-semibold">{waiting
        ? recoveryWaitReason === 'queued_message' ? 'Paused for your queued message' : 'Answer the pending request first'
        : authReady && openAI ? 'OpenAI login ready' : recovering ? (recoveryState === 'waiting' ? 'Waiting to resume' : 'Resuming task…') : notice.title}</div>
      <div className="mt-1 text-amber-800 dark:text-amber-200">{waiting
        ? recoveryWaitReason === 'queued_message' ? 'Your queued message takes priority. Send it below, or remove it to let recovery check saved progress.' : 'Recovery is paused until you resolve the pending request in this task.'
        : authReady && openAI ? 'Review the saved progress, then continue the unfinished task when you are ready.'
        : recovering ? recoveryState === 'waiting'
          ? 'The task is not running. Olympus is waiting for background work or recovery evidence before trying again.'
          : 'The last run ended before completion. Olympus is checking saved progress and will try to resume shortly. You can leave this page open or come back later.'
        : recoveryState === 'exhausted' && notice.action === 'continue'
          ? 'Automatic retries have stopped. Review the saved progress, then continue the task when you are ready.'
          : notice.detail}</div>
      {waiting && recoveryWaitReason === 'queued_message' && onSendQueued && <button type="button" className={buttonClass} disabled={busy} onClick={onSendQueued}>Send queued message</button>}
      {recovering && onPause && <button type="button" className="mt-2 ml-3 underline disabled:opacity-50" disabled={busy} onClick={onPause}>Pause automatic recovery</button>}
      {!waiting && needsAuth && onOpenAIAuth && <button type="button" className={buttonClass} disabled={authBusy} onClick={onOpenAIAuth}>{notice.action === 'reconnect_openai' ? 'Reconnect OpenAI' : 'Check saved login'}</button>}
      {!waiting && actionLabel && onAction && <button type="button" className={buttonClass} disabled={busy} onClick={() => onAction(notice.action)}>{actionLabel}</button>}
      {!waiting && !recovering && !needsAuth && onContinue && <button type="button" className={`${buttonClass} ${actionLabel ? 'ml-3' : ''}`} disabled={busy} onClick={onContinue}>{busy ? 'Starting…' : 'Continue saved work'}</button>}
    </div>
  );
}
