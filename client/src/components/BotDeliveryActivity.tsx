import type { BotMessage } from '@shared/types';
import { ArrowRight, Loader2 } from 'lucide-react';

export function BotDeliveryActivity({ messages, pendingId, onAction }: {
  messages: BotMessage[];
  pendingId: string | null;
  onAction: (id: string, action: 'retry' | 'cancel') => void;
}) {
  return <div className="max-h-52 overflow-y-auto">
    {messages.length === 0 && <p className="py-2 text-xs text-zinc-500">No bot messages yet.</p>}
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {[...messages].sort((a, b) => b.createdAt - a.createdAt).map(message => <li key={message.id} className="py-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{message.senderLabel}</span><ArrowRight size={12} aria-hidden="true" /><span className="font-medium">{message.recipientLabel}</span>
          <span className="ml-auto text-zinc-500">{message.kind === 'reply' ? 'Reply' : 'Message'} · {message.status}</span>
        </div>
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer truncate text-zinc-600 dark:text-zinc-400">{message.message}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{message.message}</p>
        </details>
        {message.error && <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400">{message.error}</p>}
        {message.status === 'interrupted' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Delivery may have reached the bot. Check the recipient’s chat before retrying.</p>}
        {(['failed', 'interrupted', 'queued', 'running'].includes(message.status)) && <div className="mt-1.5 flex items-center gap-2">
          {pendingId === message.id && <Loader2 size={12} className="animate-spin" aria-label="Updating delivery" />}
          {(message.status === 'failed' || message.status === 'interrupted') && <button type="button" disabled={pendingId !== null} onClick={() => onAction(message.id, 'retry')} className="text-xs font-medium underline disabled:opacity-40">Retry delivery</button>}
          {(message.status === 'queued' || message.status === 'running') && <button type="button" disabled={pendingId !== null} onClick={() => onAction(message.id, 'cancel')} className="text-xs font-medium underline disabled:opacity-40">Cancel delivery</button>}
        </div>}
      </li>)}
    </ul>
  </div>;
}
