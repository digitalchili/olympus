import { Bot, Brain, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createHermesProfile,
  deleteHermesProfile,
  fetchHermesProfiles,
  type HermesProfile,
} from '../lib/api';
import { toErrorMessage } from '../lib/format';

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function ProfilesSettings() {
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchHermesProfiles();
      setProfiles(result.profiles);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not load Hermes profiles.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const profileName = name.trim();
    if (!PROFILE_NAME.test(profileName)) {
      setError('Use lowercase letters, numbers, and hyphens only.');
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const result = await createHermesProfile({ name: profileName, description: description.trim() || undefined });
      setProfiles((current) => [...current, result.profile].sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name))));
      setName('');
      setDescription('');
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not create profile.'));
    } finally {
      setIsCreating(false);
    }
  }, [description, name]);

  const remove = useCallback(async (profile: HermesProfile) => {
    if (!window.confirm(`Delete Hermes profile “${profile.name}”? This permanently removes that profile’s local state.`)) return;
    setDeleting(profile.name);
    setError(null);
    try {
      await deleteHermesProfile(profile.name);
      setProfiles((current) => current.filter((item) => item.name !== profile.name));
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not delete profile.'));
    } finally {
      setDeleting(null);
    }
  }, []);

  return (
    <section aria-labelledby="profiles-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="profiles-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Hermes profiles</h2>
          <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
            Isolated Hermes identities with their own configuration, SOUL, skills, sessions, and memory boundary.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading || isCreating || deleting !== null}
          title="Refresh profiles"
          aria-label="Refresh profiles"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {profiles.map((profile) => (
          <article key={profile.name} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-start gap-3">
              <Bot size={16} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{profile.name}</h3>
                  {profile.active && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">Active</span>}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{profile.provider ?? 'default provider'} · {profile.model ?? 'default model'}</span>
                </div>
                {profile.description && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{profile.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span>{profile.skillCount} skills</span>
                  <span className="inline-flex items-center gap-1"><Brain size={12} />{profile.hasSoul ? 'SOUL configured' : 'No SOUL yet'}</span>
                </div>
                {profile.soulPreview && <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-zinc-400 dark:text-zinc-500" title={profile.soulPreview}>{profile.soulPreview}</p>}
                <details className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <summary className="cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-200">Show {profile.skillCount} skills</summary>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {profile.skills.map((skill) => <span key={skill} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{skill}</span>)}
                  </div>
                </details>
              </div>
              {!profile.active && profile.name !== 'default' && (
                <button
                  type="button"
                  onClick={() => void remove(profile)}
                  disabled={deleting !== null || isCreating}
                  aria-label={`Delete ${profile.name}`}
                  title={`Delete ${profile.name}`}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </article>
        ))}
        {!isLoading && profiles.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No Hermes profiles found.</p>}
      </div>

      <form onSubmit={create} className="mt-4 grid gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="new-profile" aria-label="New profile name" className="h-9 rounded-md border border-zinc-200 bg-white px-2.5 text-sm outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-zinc-700" />
        <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={240} placeholder="What this profile owns" aria-label="Profile description" className="h-9 rounded-md border border-zinc-200 bg-white px-2.5 text-sm outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-zinc-700" />
        <button type="submit" disabled={isCreating || deleting !== null || !name.trim()} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
          <Plus size={14} />{isCreating ? 'Adding…' : 'Add profile'}
        </button>
      </form>
      <p className={`mt-2 text-xs ${error ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`}>
        {error ?? 'New profiles start isolated; they do not copy personal memory or Telegram settings.'}
      </p>
    </section>
  );
}
