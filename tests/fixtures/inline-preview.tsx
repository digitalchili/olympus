import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskInlinePreviews } from '../../client/src/components/TaskInlinePreviews';
import { MessageAttachmentCards } from '../../client/src/components/ChatAttachments';
import { stripPublishedPreviewManifests } from '../../client/src/lib/inlinePreviews';
import { splitAttachmentMessage } from '../../client/src/lib/format';
import type { TaskAttachment } from '../../shared/types';
import '../../client/src/styles/globals.css';

function Fixture() {
  const [message, setMessage] = useState<{ taskId: string; content: string; attachments: TaskAttachment[] } | null>(null);
  const [input, setInput] = useState('');
  useEffect(() => { void fetch('/qa/message').then(r => r.json()).then(setMessage); }, []);
  return <main className="mx-auto max-w-[820px] p-3 font-sans text-zinc-700 sm:p-6"><header className="mb-6 border-b border-zinc-200 pb-4"><h1 className="text-lg font-semibold text-zinc-900">Olympus</h1><p className="text-xs text-zinc-500">Disposable inline-preview verification · no live task or agent</p></header>{message ? <><p className="mb-3 text-sm">{stripPublishedPreviewManifests(splitAttachmentMessage(message.content).text, message.attachments)}</p><MessageAttachmentCards taskId={message.taskId} attachments={message.attachments} /><TaskInlinePreviews taskId={message.taskId} attachments={message.attachments} onDraftPrompt={prompt => setInput(current => current ? `${current}\n\n${prompt}` : prompt)} /><label className="block text-sm">Message box<textarea aria-label="Message box" value={input} onChange={e => setInput(e.target.value)} rows={6} className="mt-2 w-full rounded-xl border border-zinc-300 p-3 text-sm" /></label><p className="mt-2 text-xs text-zinc-500">In a real task, Send uses the existing chat admission and approval flow. This fixture never starts an agent.</p></> : <p>Loading real fixture artifacts…</p>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
