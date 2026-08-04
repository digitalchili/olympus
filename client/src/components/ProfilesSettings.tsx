import { Bot, Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  REASONING_EFFORTS,
  type HermesProfileSettings,
  type HermesProfileSettingsUpdate,
  type ReasoningEffort,
} from '@shared/types';
import {
  fetchHermesProfiles,
  fetchProfileSettings,
  updateProfileSettings,
  type HermesProfile,
} from '../lib/api';
import { toErrorMessage } from '../lib/format';

type EditableProfileSettings = HermesProfileSettings & {
  show_reasoning?: boolean;
  showReasoning?: boolean;
};

export function ProfilesSettings() {
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<HermesProfile | null>(null);
  const [settings, setSettings] = useState<EditableProfileSettings | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchHermesProfiles();
      setProfiles(result.profiles);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not load local Hermes profiles.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!editingProfile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) setEditingProfile(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingProfile, isSaving]);

  const openEditor = async (profile: HermesProfile) => {
    setEditingProfile(profile);
    setSettings(null);
    setDrawerError(null);
    setIsLoadingSettings(true);
    try {
      const result = await fetchProfileSettings(profile.id);
      setSettings(result.settings as EditableProfileSettings);
    } catch (cause) {
      setDrawerError(toErrorMessage(cause, 'Could not load profile settings.'));
    } finally {
      setIsLoadingSettings(false);
    }
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingProfile || !settings) return;

    setIsSaving(true);
    setDrawerError(null);
    const updates: HermesProfileSettingsUpdate & {
      show_reasoning?: boolean;
      showReasoning?: boolean;
    } = {
      description: settings.description,
      provider: settings.provider?.trim() || null,
      model: settings.model?.trim() || null,
      reasoningEffort: settings.reasoningEffort,
      soul: settings.soul,
    };
    if ('show_reasoning' in settings) updates.show_reasoning = Boolean(settings.show_reasoning);
    else if ('showReasoning' in settings) updates.showReasoning = Boolean(settings.showReasoning);

    try {
      await updateProfileSettings(editingProfile.id, updates);
      await load();
      setEditingProfile(null);
      setSettings(null);
    } catch (cause) {
      setDrawerError(toErrorMessage(cause, 'Could not save profile settings.'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasShowReasoning = settings
    ? 'show_reasoning' in settings || 'showReasoning' in settings
    : false;
  const showReasoning = Boolean(settings?.show_reasoning ?? settings?.showReasoning);

  return (
    <>
      <section aria-labelledby="profiles-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="profiles-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Local Hermes profiles</h2>
            <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
              Profiles are discovered from the Hermes installation on this machine. Each profile keeps its own settings and sessions.
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
                    {profile.isDefault && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {profile.description || 'No description provided.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void openEditor(profile)}
                  title={`Edit ${profile.label}`}
                  aria-label={`Edit ${profile.label}`}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  <Pencil size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>

        <p className={`mt-2 text-xs ${error ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {error ?? 'Create or edit profiles with Hermes, then refresh this list.'}
        </p>
      </section>

      {editingProfile && (
        <div className="fixed inset-0 z-50" role="presentation">
          <button
            type="button"
            aria-label="Close profile settings"
            onClick={() => !isSaving && setEditingProfile(null)}
            className="absolute inset-0 bg-black/35"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-settings-title"
            className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="min-w-0">
                <h2 id="profile-settings-title" className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {editingProfile.label}
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Profile settings</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingProfile(null)}
                disabled={isSaving}
                aria-label="Close profile settings"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X size={16} />
              </button>
            </div>

            {isLoadingSettings ? (
              <div className="flex flex-1 items-center justify-center text-zinc-500 dark:text-zinc-400">
                <Loader2 size={20} className="animate-spin" aria-label="Loading profile settings" />
              </div>
            ) : settings ? (
              <form onSubmit={saveSettings} className="flex min-h-0 flex-1 flex-col">
                <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
                  <label className="block">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Description</span>
                    <textarea
                      value={settings.description}
                      onChange={(event) => setSettings({ ...settings, description: event.target.value })}
                      rows={3}
                      maxLength={500}
                      disabled={isSaving}
                      className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                    />
                  </label>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Provider</span>
                      <input
                        type="text"
                        value={settings.provider ?? ''}
                        onChange={(event) => setSettings({ ...settings, provider: event.target.value })}
                        maxLength={200}
                        disabled={isSaving}
                        placeholder="Use profile default"
                        className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                      />
                    </label>
                    <label className="block">
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Model</span>
                      <input
                        type="text"
                        value={settings.model ?? ''}
                        onChange={(event) => setSettings({ ...settings, model: event.target.value })}
                        maxLength={200}
                        disabled={isSaving}
                        placeholder="Use profile default"
                        className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Reasoning effort</span>
                    <select
                      value={settings.reasoningEffort ?? ''}
                      onChange={(event) => setSettings({
                        ...settings,
                        reasoningEffort: (event.target.value || null) as ReasoningEffort | null,
                      })}
                      disabled={isSaving}
                      className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                    >
                      <option value="">Use profile default</option>
                      {REASONING_EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>{effort}</option>
                      ))}
                    </select>
                  </label>

                  {hasShowReasoning && (
                    <label className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
                      <input
                        type="checkbox"
                        checked={showReasoning}
                        onChange={(event) => {
                          if ('show_reasoning' in settings) {
                            setSettings({ ...settings, show_reasoning: event.target.checked });
                          } else {
                            setSettings({ ...settings, showReasoning: event.target.checked });
                          }
                        }}
                        disabled={isSaving}
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950"
                      />
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Show reasoning</span>
                    </label>
                  )}

                  <label className="block">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">SOUL.md</span>
                    <textarea
                      value={settings.soul}
                      onChange={(event) => setSettings({ ...settings, soul: event.target.value })}
                      rows={16}
                      disabled={isSaving}
                      spellCheck={false}
                      className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs leading-5 text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                    />
                  </label>

                  {drawerError && <p className="text-sm text-red-500" role="alert">{drawerError}</p>}
                </div>

                <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setEditingProfile(null)}
                    disabled={isSaving}
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    {isSaving && <Loader2 size={14} className="animate-spin" />}
                    {isSaving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
                <p className="text-sm text-red-500" role="alert">{drawerError ?? 'Profile settings are unavailable.'}</p>
                <button
                  type="button"
                  onClick={() => void openEditor(editingProfile)}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Try again
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
