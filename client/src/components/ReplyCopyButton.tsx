import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../lib/clipboard';

type CopyStatus = 'idle' | 'copied' | 'error';

export function shouldShowReplyCopyButton(content: string, isStreaming: boolean): boolean {
  return Boolean(content) && !isStreaming;
}

export function ReplyCopyButton({ content }: { content: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copyReply = async () => {
    try {
      await copyTextToClipboard(content);
      setStatus('copied');
    } catch {
      setStatus('error');
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setStatus('idle'), 2_000);
  };

  const label = status === 'copied'
    ? 'Reply copied'
    : status === 'error'
      ? 'Copy failed'
      : 'Copy reply';

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-reply-copy-button="true"
      onClick={() => void copyReply()}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
