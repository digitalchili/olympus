import { Bot, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fetchHermesProfiles, type HermesProfile } from '../lib/api';
import { toErrorMessage } from '../lib/format';

export function ProfilesSettings() {
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchHermesProfiles();
      setProfiles(result.profiles);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not load remote profiles.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="profiles-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="profiles-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Remote execution profiles</h2>
          <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
            Olympus uses local Hermes by default. Optional remote profiles are loaded from this server's runtime configuration.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          title="Refresh profiles"
          aria-label="Refresh profiles"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {profiles.map((profile) => (
          <article key={profile.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-start gap-3">
              <Bot size={16} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{profile.label}</h3>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    profile.available
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                      : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                  }`}>
                    {profile.available ? 'Available' : 'Not configured'}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{profile.remoteProfile}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{profile.description}</p>
              </div>
            </div>
          </article>
        ))}
        {!isLoading && profiles.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No remote profiles found.</p>}
      </div>

      <p className={`mt-2 text-xs ${error ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`}>
        {error ?? 'Endpoints and API keys are configured only on the server.'}
      </p>
    </section>
  );
}
