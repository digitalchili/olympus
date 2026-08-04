import { Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { HermesChannel } from '@shared/types';
import { useProfile } from '../contexts/ProfileContext';
import { fetchHermesChannels } from '../lib/api';

export function ChannelSettings() {
  const { activeProfileId } = useProfile();
  const [channels, setChannels] = useState<HermesChannel[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchHermesChannels()
      .then((result) => { if (!cancelled) setChannels(result.channels); })
      .catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, []);

  const command = activeProfileId === 'default'
    ? 'hermes gateway setup'
    : `hermes -p ${activeProfileId} gateway setup`;
  const enabled = channels.filter((channel) => channel.enabled);

  return (
    <section id="channels" aria-labelledby="channels-title" className="scroll-mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="flex items-start gap-3">
        <Radio size={18} className="mt-0.5 shrink-0 text-zinc-500" />
        <div className="min-w-0">
          <h2 id="channels-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Channel connections</h2>
          <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
            Hermes owns authentication and delivery. Olympus only reads secret-free connection status.
          </p>
        </div>
      </div>
      {enabled.length > 0 && (
        <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-300">
          Connected here: {enabled.map((channel) => channel.displayLabel).join(', ')}
        </p>
      )}
      <p className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        To disconnect or reconfigure a channel, use Hermes settings for this profile:
      </p>
      <code className="mt-2 block w-fit max-w-full overflow-x-auto rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
        {command}
      </code>
    </section>
  );
}
