import { ChevronDown, Inbox, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  HermesChannel,
  HermesChannelHealth,
  HermesChannelMessagesResult,
  HermesChannelThreadsResult,
} from '@shared/types';
import { ProfileLink } from '../contexts/ProfileContext';
import { fetchChannelMessages, fetchChannelThreads } from '../lib/api';
import {
  channelMessageAuthor,
  channelMessagesStatusText,
  channelThreadsStatusText,
} from '../lib/channelInbox';

const HEALTH: Record<HermesChannelHealth, { label: string; dot: string }> = {
  healthy: { label: 'Connected', dot: 'bg-emerald-500' },
  degraded: { label: 'Needs attention', dot: 'bg-amber-500' },
  unknown: { label: 'Status unavailable', dot: 'bg-zinc-400' },
  inactive: { label: 'Inactive', dot: 'bg-zinc-400' },
};

export function ChannelInboxCard({ channel, profileId }: { channel: HermesChannel; profileId: string }) {
  const [expanded, setExpanded] = useState(true);
  const [threads, setThreads] = useState<HermesChannelThreadsResult | null>(null);
  const [threadError, setThreadError] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<HermesChannelMessagesResult | null>(null);
  const [messageError, setMessageError] = useState(false);
  const health = HEALTH[channel.health];
  const contentId = `channel-inbox-${channel.id}`;

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setThreads(null);
    setThreadError(false);
    setSelectedThreadId(null);
    setMessages(null);
    setMessageError(false);

    void fetchChannelThreads(channel.id, profileId)
      .then((result) => {
        if (cancelled) return;
        setThreads(result);
        setSelectedThreadId(result.state === 'available' ? result.threads[0]?.id ?? null : null);
      })
      .catch(() => {
        if (!cancelled) setThreadError(true);
      });

    return () => { cancelled = true; };
  }, [channel.id, expanded, profileId]);

  useEffect(() => {
    if (!expanded || !selectedThreadId) return;
    let cancelled = false;
    setMessages(null);
    setMessageError(false);

    void fetchChannelMessages(channel.id, selectedThreadId, profileId)
      .then((result) => {
        if (!cancelled) setMessages(result);
      })
      .catch(() => {
        if (!cancelled) setMessageError(true);
      });

    return () => { cancelled = true; };
  }, [channel.id, expanded, profileId, selectedThreadId]);

  const threadStatus = threads ? channelThreadsStatusText(threads) : null;
  const messageStatus = messages ? channelMessagesStatusText(messages) : null;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-2 p-3.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60"
        >
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <Inbox size={15} strokeWidth={2.3} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {channel.displayLabel} Inbox
              </span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                Pinned
              </span>
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className={`h-1.5 w-1.5 rounded-full ${health.dot}`} />
              Active · {health.label}
            </span>
          </span>
          <ChevronDown
            size={16}
            className={`mt-1 shrink-0 text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {expanded && (
        <div id={contentId} className="border-t border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Conversations</p>
          {!threads && !threadError && (
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">Loading local conversations…</p>
          )}
          {threadError && (
            <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">Could not load local conversations.</p>
          )}
          {threadStatus && (
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{threadStatus}</p>
          )}
          {threads?.state === 'available' && threads.threads.length > 0 && (
            <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
              {threads.threads.map((thread) => {
                const selected = selectedThreadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedThreadId(thread.id)}
                    className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                        : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold">{thread.title}</span>
                      <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                        {thread.messageCount}
                      </span>
                    </span>
                    {thread.preview && (
                      <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                        {thread.preview}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {selectedThreadId && (
            <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Messages</p>
              {!messages && !messageError && (
                <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">Loading messages…</p>
              )}
              {messageError && (
                <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">Could not load local messages.</p>
              )}
              {messageStatus && (
                <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{messageStatus}</p>
              )}
              {messages?.state === 'available' && messages.messages.length > 0 && (
                <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                  {messages.truncated && (
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500">Showing the latest messages.</p>
                  )}
                  {messages.messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className="max-w-[90%] rounded-lg bg-zinc-100 px-2.5 py-2 dark:bg-zinc-800">
                        <p className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">
                          {channelMessageAuthor(message.direction)}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-zinc-800 dark:text-zinc-200">
                          {message.content}
                        </p>
                        {message.contentTruncated && (
                          <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">Message truncated.</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Local read-only history.</p>
            <ProfileLink
              to="/settings#channels"
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            >
              <Settings size={12} />
              Disconnect in settings
            </ProfileLink>
          </div>
        </div>
      )}
    </article>
  );
}
