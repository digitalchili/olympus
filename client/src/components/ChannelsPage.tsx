import { Radio, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import type { HermesChannel } from '@shared/types';
import { ProfileLink, useProfile } from '../contexts/ProfileContext';
import { fetchHermesChannels } from '../lib/api';
import {
  channelInboxPath,
  enabledChannelInboxes,
  selectedChannelInbox,
} from '../lib/channelInbox';
import { ChannelInboxCard } from './ChannelInboxCard';

function ChannelSettingsLink() {
  return (
    <ProfileLink
      to="/settings#channels"
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      <Settings size={14} />
      Channel settings
    </ProfileLink>
  );
}

export function ChannelsPage() {
  const location = useLocation();
  const { activeProfileId } = useProfile();
  const [channels, setChannels] = useState<HermesChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChannels([]);
    setLoading(true);
    setError(null);

    void fetchHermesChannels(activeProfileId)
      .then((result) => {
        if (!cancelled) setChannels(enabledChannelInboxes(result.channels));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load local channels.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeProfileId]);

  const requestedChannelId = new URLSearchParams(location.search).get('channel');
  const selectedChannel = selectedChannelInbox(channels, requestedChannelId);

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Channels</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Read-only conversation history from this local Hermes profile.
            </p>
          </div>
          <ChannelSettingsLink />
        </div>

        {channels.length > 1 && (
          <nav aria-label="Channels" className="mt-5 flex gap-2 overflow-x-auto pb-1">
            {channels.map((channel) => {
              const active = selectedChannel?.id === channel.id;
              return (
                <ProfileLink
                  key={channel.id}
                  to={channelInboxPath(channel.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:text-zinc-100'
                  }`}
                >
                  <Radio size={14} />
                  {channel.displayLabel}
                </ProfileLink>
              );
            })}
          </nav>
        )}

        <div className="mt-5">
          {loading && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              Loading local channels…
            </div>
          )}
          {!loading && error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
              {error}
            </div>
          )}
          {!loading && !error && !selectedChannel && (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-center dark:border-zinc-700 dark:bg-zinc-900">
              <Radio size={22} className="mx-auto text-zinc-400" />
              <p className="mt-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">No connected channels</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Enable a user-facing channel in Hermes settings for this profile.
              </p>
              <div className="mt-4 flex justify-center"><ChannelSettingsLink /></div>
            </div>
          )}
          {!loading && !error && selectedChannel && (
            <ChannelInboxCard
              key={`${activeProfileId}:${selectedChannel.id}`}
              channel={selectedChannel}
              profileId={activeProfileId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
