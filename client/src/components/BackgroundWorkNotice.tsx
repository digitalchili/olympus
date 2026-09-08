import { useEffect, useState } from 'react';
import type { TaskBackgroundWorkStatus } from '@shared/background-work';
import { fetchTaskBackgroundWork, stopTaskBackgroundWork } from '../lib/api';
import { toErrorMessage } from '../lib/format';

/** Only visible when idle chat is blocked; normal conversations stay uncluttered. */
export function BackgroundWorkNotice({ taskId, isStreaming }: { taskId: string; isStreaming: boolean }) {
  const [inventory, setInventory] = useState<TaskBackgroundWorkStatus | null>(null);
  const [confirmation, setConfirmation] = useState<TaskBackgroundWorkStatus | null>(null);
  const confirming = Boolean(confirmation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let active = true;
    setInventory(null); setConfirmation(null); setCleared(false); setError('');
    if (isStreaming) return;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await fetchTaskBackgroundWork(taskId);
        if (active) { setInventory(result); setError(''); }
      } catch (e) {
        if (active) setError(toErrorMessage(e, 'Could not check background work.'));
      } finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [taskId, isStreaming]);

  if (isStreaming || (!error && !cleared && (!inventory || (inventory.available && !inventory.work.length)))) return null;
  const checkAgain = async () => {
    setBusy(true); setError(''); setConfirmation(null);
    try {
      const result = await fetchTaskBackgroundWork(taskId);
      setInventory(result); setCleared(result.available && !result.work.length);
    } catch (e) { setError(toErrorMessage(e, 'Could not check background work.')); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!confirmation?.canStop) return;
    setBusy(true); setError('');
    try {
      await stopTaskBackgroundWork(taskId, confirmation.runId, confirmation.work.map(item => item.id));
      setInventory(null); setCleared(true); setConfirmation(null);
    } catch (e) { setError(toErrorMessage(e, 'Could not stop background work.')); setConfirmation(null); }
    finally { setBusy(false); }
  };
  const blocked = Boolean(inventory?.work.length);
  return <section aria-label="Task recovery" className="mx-auto mb-3 max-w-[760px] rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
    <p role="status" className="font-medium">{busy ? (confirming ? 'Stopping background work…' : 'Checking background work…')
      : cleared && !blocked ? 'Ready to continue — send your message below.'
      : inventory?.canStop ? 'Background work is keeping this task open.'
      : blocked ? 'This task still has work running.' : 'Background status could not be checked.'}</p>
    {blocked && <p className="mt-1">{inventory!.work.filter(item => item.kind === 'process').length} background command(s){inventory!.work.some(item => item.kind !== 'process') ? ' · Agent or delegated work is still active.' : ''}</p>}
    {confirming && <p className="mt-2">Stop this task’s background commands, including any preview server? This interrupts those commands. Saved files and chat are kept. Your message will not be sent automatically.</p>}
    {error && <p role="alert" className="mt-1 text-red-600">{error}</p>}
    {(!cleared || blocked || error) && <div className="mt-2 flex gap-3">
      <button disabled={busy} className="underline disabled:opacity-40" onClick={() => void checkAgain()}>{confirming ? 'Cancel' : 'Check again'}</button>
      {inventory?.canStop && <button disabled={busy} className="font-medium underline disabled:opacity-40" onClick={() => confirming ? void stop() : setConfirmation(inventory)}>{confirming ? 'Confirm stop' : 'Stop background work'}</button>}
    </div>}
  </section>;
}
