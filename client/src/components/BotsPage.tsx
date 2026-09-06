import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, SquarePen } from 'lucide-react';
import type { BotMessage, Task } from '@shared/types';
import { cancelBotMessage, ensureBotSession, fetchBotMessages, fetchBots, retryBotMessage, type BotRosterEntry } from '../lib/api';
import { ProfileLink, useProfile } from '../contexts/ProfileContext';
import { usePageHeader } from './Header';
import { TaskChat } from './TaskChat';
import { BotDeliveryActivity } from './BotDeliveryActivity';

export function BotsPage() {
  const { activeProfile, activeProfileId, profiles, isLoading, error: profileError, setActiveProfileId } = useProfile();
  const [bots, setBots] = useState<BotRosterEntry[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [activityError, setActivityError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pageHeader = useMemo(() => ({
    crumbs: [{ label: 'Bots' }, { label: activeProfile?.displayName ?? 'Conversation' }],
    actions: <ProfileLink to="/tasks/new" className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium dark:border-zinc-700"><SquarePen size={13} />New Task</ProfileLink>,
  }), [activeProfile?.displayName]);
  usePageHeader(pageHeader);

  useEffect(() => {
    let cancelled = false;
    void fetchBots().then(result => { if (!cancelled) setBots(result.bots); }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProfileId, retry]);

  useEffect(() => {
    if (isLoading || !activeProfile) return;
    let cancelled = false;
    setTask(null); setSessionError('');
    void ensureBotSession(activeProfileId).then(result => {
      if (!cancelled) setTask(result.task);
    }).catch(error => { if (!cancelled) setSessionError(error instanceof Error ? error.message : 'Could not open this bot.'); });
    return () => { cancelled = true; };
  }, [activeProfileId, activeProfile, isLoading, retry]);

  useEffect(() => {
    if (isLoading || !activeProfile) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await fetchBotMessages(activeProfileId);
        if (!cancelled) { setMessages(result.messages); setActivityError(''); }
      } catch { if (!cancelled) setActivityError('Could not refresh bot delivery activity.'); }
      if (!cancelled) timer = setTimeout(refresh, 2_000);
    };
    setMessages([]); setActionError('');
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeProfileId, activeProfile, isLoading]);

  const handleAction = async (id: string, action: 'retry' | 'cancel') => {
    if (pendingId) return;
    setPendingId(id); setActionError('');
    try {
      await (action === 'retry' ? retryBotMessage(id, activeProfileId) : cancelBotMessage(id, activeProfileId));
      setMessages((await fetchBotMessages(activeProfileId)).messages);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update this delivery.');
    } finally { setPendingId(null); }
  };

  const roster = bots.length ? bots.map(bot => bot.profile) : profiles;
  return <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
    <nav aria-label="Bots" className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 p-2 dark:border-zinc-800 lg:w-48 lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r">
      {roster.map(profile => <button key={profile.id} type="button" aria-current={profile.id === activeProfileId ? 'page' : undefined} onClick={() => setActiveProfileId(profile.id)}
        className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm lg:shrink ${profile.id === activeProfileId ? 'bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}>
        <Bot size={17} className="shrink-0" />
        <span className="min-w-0"><span className="block truncate font-medium">{profile.displayName}</span><span className="hidden truncate text-xs text-zinc-500 lg:block">@{profile.id}</span></span>
      </button>)}
    </nav>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {profileError || sessionError ? <div role="alert" className="p-6 text-sm text-red-600 dark:text-red-400">
        {profileError || sessionError}{!profileError && <button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 underline">Retry</button>}
      </div> : !task ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500"><Loader2 size={18} className="animate-spin" />Opening bot conversation…</div>
        : <TaskChat key={task.id} taskId={task.id} conversationKind="bot" />}
      <details className="shrink-0 border-t border-zinc-200 px-4 py-2 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
        <summary className="cursor-pointer text-xs font-medium">Bot messages · {messages.length}{messages.some(message => message.status === 'queued' || message.status === 'running') ? ' · Delivery in progress' : ''}</summary>
        <BotDeliveryActivity messages={messages} pendingId={pendingId} onAction={(id, action) => void handleAction(id, action)} />
      </details>
      {(activityError || actionError) && <p role="alert" className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{actionError || activityError}</p>}
    </div>
  </div>;
}
