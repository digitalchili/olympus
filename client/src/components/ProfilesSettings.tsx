import {
  Bot,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  REASONING_EFFORTS,
  type AgentModelGroup,
  type HermesProfileSettings,
  type HermesProfileSettingsUpdate,
  type ReasoningEffort,
} from '@shared/types';
import {
  createHermesProfile,
  deactivateHermesProfile,
  deleteHermesProfile,
  draftHermesProfile,
  fetchAgentModels,
  fetchHermesProfiles,
  fetchProfileSettings,
  reactivateHermesProfile,
  updateProfileSettings,
  type HermesProfile,
} from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { useProfile } from '../contexts/ProfileContext';
import { ModelPicker, parseQualifiedModelValue } from './InputToolbar';

type DrawerMode = 'create' | 'edit';

const EMPTY_SETTINGS: HermesProfileSettings = {
  id: '',
  displayName: '',
  description: '',
  model: null,
  provider: null,
  reasoningEffort: null,
  soul: '',
};

const BUILDER_STEPS = ['Purpose', 'Soul', 'Capabilities'] as const;

function slugFromName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, '')
    .slice(0, 64);
}

function EditSection({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/40">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={15} className="shrink-0 text-zinc-400 transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">{summary}</span>
        </span>
      </summary>
      <div className="space-y-4 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">{children}</div>
    </details>
  );
}

export function ProfilesSettings() {
  const {
    activeProfileId,
    error: selectorError,
    refreshProfiles,
  } = useProfile();
  const [allProfiles, setAllProfiles] = useState<HermesProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<DrawerMode | null>(null);
  const [editingProfile, setEditingProfile] = useState<HermesProfile | null>(null);
  const [settings, setSettings] = useState<HermesProfileSettings | null>(null);
  const [initialSettings, setInitialSettings] = useState<HermesProfileSettings | null>(null);
  const [modelGroups, setModelGroups] = useState<AgentModelGroup[]>([]);
  const [builderStep, setBuilderStep] = useState(0);
  const [draftDescription, setDraftDescription] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [actionProfileId, setActionProfileId] = useState<string | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  const refreshAllProfiles = useCallback(async () => {
    setIsLoading(true);
    setListError(null);
    try {
      const result = await fetchHermesProfiles(true);
      setAllProfiles(result.profiles);
    } catch (cause) {
      setListError(toErrorMessage(cause, 'Could not load Hermes profiles.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshEverything = useCallback(async () => {
    await Promise.all([refreshAllProfiles(), refreshProfiles()]);
  }, [refreshAllProfiles, refreshProfiles]);

  useEffect(() => {
    void refreshAllProfiles();
  }, [refreshAllProfiles]);

  useEffect(() => {
    if (!drawerMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving && !isDrafting) setDrawerMode(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerMode, isDrafting, isSaving]);

  const openBuilder = async () => {
    setDrawerMode('create');
    setEditingProfile(null);
    setSettings({ ...EMPTY_SETTINGS });
    setInitialSettings(null);
    setBuilderStep(0);
    setDraftDescription('');
    setIsDrafting(false);
    setSlugEdited(false);
    setDeleteConfirmation('');
    setDrawerError(null);
    setModelGroups([]);
    setIsLoadingSettings(true);
    try {
      const models = await fetchAgentModels();
      setModelGroups(models.groups);
    } catch (cause) {
      setDrawerError(toErrorMessage(cause, 'Could not load models. You can still create the profile.'));
    } finally {
      setIsLoadingSettings(false);
    }
  };

  const openEditor = async (profile: HermesProfile) => {
    setDrawerMode('edit');
    setEditingProfile(profile);
    setSettings(null);
    setInitialSettings(null);
    setBuilderStep(0);
    setIsDrafting(false);
    setDeleteConfirmation('');
    setDrawerError(null);
    setModelGroups([]);
    setIsLoadingSettings(true);
    const [settingsResult, modelsResult] = await Promise.allSettled([
      fetchProfileSettings(profile.id),
      fetchAgentModels(),
    ]);
    if (settingsResult.status === 'fulfilled') {
      setSettings(settingsResult.value.settings);
      setInitialSettings(settingsResult.value.settings);
    } else {
      setDrawerError(toErrorMessage(settingsResult.reason, 'Could not load profile settings.'));
    }
    if (modelsResult.status === 'fulfilled') {
      setModelGroups(modelsResult.value.groups);
    } else if (settingsResult.status === 'fulfilled') {
      setDrawerError(toErrorMessage(modelsResult.reason, 'Could not load models. Existing capability settings are preserved.'));
    }
    setIsLoadingSettings(false);
  };

  const draftProfile = async () => {
    const description = draftDescription.trim();
    if (!settings || !description) return;

    setIsDrafting(true);
    setDrawerError(null);
    try {
      const { suggestion } = await draftHermesProfile(description);
      setSettings((current) => current ? {
        ...current,
        ...suggestion,
        id: slugEdited ? current.id : slugFromName(suggestion.displayName),
      } : current);
      setBuilderStep(0);
    } catch (cause) {
      setDrawerError(toErrorMessage(cause, 'Hermes could not draft this profile.'));
    } finally {
      setIsDrafting(false);
    }
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!drawerMode || !settings) return;

    setIsSaving(true);
    setDrawerError(null);
    const normalized = {
      ...settings,
      id: settings.id.trim(),
      displayName: settings.displayName.trim(),
      description: settings.description.trim(),
      provider: settings.provider?.trim() || null,
      model: settings.model?.trim() || null,
    };

    try {
      if (drawerMode === 'create') {
        await createHermesProfile({ ...normalized, active: true });
      } else if (editingProfile) {
        const updates: HermesProfileSettingsUpdate = {};
        if (!initialSettings || normalized.displayName !== initialSettings.displayName) updates.displayName = normalized.displayName;
        if (!initialSettings || normalized.description !== initialSettings.description) updates.description = normalized.description;
        if (!initialSettings || normalized.provider !== initialSettings.provider) updates.provider = normalized.provider;
        if (!initialSettings || normalized.model !== initialSettings.model) updates.model = normalized.model;
        if (!initialSettings || normalized.reasoningEffort !== initialSettings.reasoningEffort) updates.reasoningEffort = normalized.reasoningEffort;
        if (!initialSettings || normalized.soul !== initialSettings.soul) updates.soul = normalized.soul;
        if (Object.keys(updates).length > 0) await updateProfileSettings(editingProfile.id, updates);
      }
      await refreshEverything();
      setDrawerMode(null);
      setSettings(null);
    } catch (cause) {
      setDrawerError(toErrorMessage(cause, drawerMode === 'create' ? 'Could not create profile.' : 'Could not save profile settings.'));
    } finally {
      setIsSaving(false);
    }
  };

  const toggleActive = async (profile: HermesProfile) => {
    setActionProfileId(profile.id);
    setListError(null);
    try {
      if (profile.active) await deactivateHermesProfile(profile.id);
      else await reactivateHermesProfile(profile.id);
      await refreshEverything();
    } catch (cause) {
      setListError(toErrorMessage(cause, `Could not ${profile.active ? 'deactivate' : 'reactivate'} profile.`));
    } finally {
      setActionProfileId(null);
    }
  };

  const deleteProfile = async () => {
    if (!editingProfile || deleteConfirmation !== editingProfile.id) return;
    setIsSaving(true);
    setDrawerError(null);
    try {
      await deleteHermesProfile(editingProfile.id, deleteConfirmation);
      await refreshEverything();
      setDrawerMode(null);
      setSettings(null);
    } catch (cause) {
      setDrawerError(toErrorMessage(cause, 'Could not delete profile.'));
    } finally {
      setIsSaving(false);
    }
  };

  const purposeFields = settings && (
    <>
      <label className="block">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Display name</span>
        <input
          type="text"
          value={settings.displayName}
          onChange={(event) => {
            const displayName = event.target.value;
            setSettings({
              ...settings,
              displayName,
              ...(drawerMode === 'create' && !slugEdited ? { id: slugFromName(displayName) } : {}),
            });
          }}
          maxLength={80}
          required
          disabled={isSaving || isDrafting}
          placeholder="Research assistant"
          className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
        />
      </label>

      {drawerMode === 'create' ? (
        <label className="block">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Immutable profile ID</span>
          <input
            type="text"
            value={settings.id}
            onChange={(event) => { setSlugEdited(true); setSettings({ ...settings, id: event.target.value.toLowerCase() }); }}
            maxLength={64}
            required
            pattern="[a-z0-9][a-z0-9._-]*"
            placeholder="research-assistant"
            disabled={isSaving || isDrafting}
            className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
          />
          <span className="mt-1.5 block text-xs text-zinc-500 dark:text-zinc-400">Lowercase letters, numbers, dots, dashes, and underscores. This cannot be renamed.</span>
        </label>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Profile ID: <code>{settings.id}</code> · The ID stays unchanged when you rename this profile.
        </p>
      )}

      <label className="block">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Description</span>
        <textarea
          value={settings.description}
          onChange={(event) => setSettings({ ...settings, description: event.target.value })}
          rows={4}
          maxLength={500}
          disabled={isSaving || isDrafting}
          placeholder="What this profile is responsible for and when to use it."
          className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
        />
      </label>
    </>
  );

  const soulFields = settings && (
    <label className="block">
      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">SOUL.md</span>
      <textarea
        value={settings.soul}
        onChange={(event) => setSettings({ ...settings, soul: event.target.value })}
        rows={18}
        disabled={isSaving || isDrafting}
        spellCheck={false}
        placeholder={'# Identity\nDescribe the profile’s role, working style, principles, and boundaries.'}
        className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs leading-5 text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
      />
      <span className="mt-1.5 block text-xs text-zinc-500 dark:text-zinc-400">Define identity, tone, decision principles, and boundaries in plain Markdown.</span>
    </label>
  );

  const capabilityFields = settings && (
    <>
      <div>
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Provider and model</span>
        <div className="mt-1.5">
          <ModelPicker
            value={settings.model ?? ''}
            provider={settings.provider}
            modelGroups={modelGroups}
            disabled={isSaving || isDrafting || modelGroups.length === 0}
            title={settings.model ? `Model: ${settings.model}` : 'Select model'}
            onChange={(nextModel, selection) => {
              const parsed = parseQualifiedModelValue(nextModel);
              setSettings({
                ...settings,
                model: parsed?.model ?? nextModel,
                provider: selection?.provider ?? parsed?.provider ?? null,
              });
            }}
          />
        </div>
        <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">Leave unselected to use Hermes defaults.</p>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Reasoning effort</span>
        <select
          value={settings.reasoningEffort ?? ''}
          onChange={(event) => setSettings({
            ...settings,
            reasoningEffort: (event.target.value || null) as ReasoningEffort | null,
          })}
          disabled={isSaving || isDrafting}
          className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
        >
          <option value="">Use Hermes default</option>
          {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>

      <div>
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Profile resources</span>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {['Settings', 'Workspace', 'Skills', 'Scheduled tasks'].map((capability) => (
            <span key={capability} className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{capability}</span>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">These isolated resources are created automatically for every profile.</p>
      </div>
    </>
  );

  return (
    <>
      <section aria-labelledby="profiles-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="profiles-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Local Hermes profiles</h2>
            <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">Create and manage isolated settings, identity, workspace, skills, and sessions.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshEverything()}
              disabled={isLoading}
              title="Refresh profiles"
              aria-label="Refresh profiles"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => void openBuilder()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              <Plus size={14} /> Create profile
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {allProfiles.map((profile) => {
            const actionPending = actionProfileId === profile.id;
            const isCurrent = profile.id === activeProfileId;
            return (
              <article key={profile.id} className={`rounded-lg border p-3 ${profile.active ? 'border-zinc-200 dark:border-zinc-800' : 'border-dashed border-zinc-300 bg-zinc-50/70 dark:border-zinc-700 dark:bg-zinc-950/30'}`}>
                <div className="flex items-start gap-3">
                  <Bot size={16} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{profile.displayName}</h3>
                      {profile.isDefault && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">Default</span>}
                      {isCurrent && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">Current</span>}
                      {!profile.active && <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Inactive</span>}
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{profile.description || 'No description provided.'}</p>
                    <p className="mt-1 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{profile.id}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!profile.isDefault && (
                      <button
                        type="button"
                        onClick={() => void toggleActive(profile)}
                        disabled={actionPending || isCurrent}
                        title={isCurrent ? 'Switch profiles before deactivating the current profile' : `${profile.active ? 'Deactivate' : 'Reactivate'} ${profile.displayName}`}
                        aria-label={`${profile.active ? 'Deactivate' : 'Reactivate'} ${profile.displayName}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        {actionPending ? <Loader2 size={14} className="animate-spin" /> : profile.active ? <PowerOff size={14} /> : <Power size={14} />}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void openEditor(profile)}
                      title={`Edit ${profile.displayName}`}
                      aria-label={`Edit ${profile.displayName}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {!isLoading && allProfiles.length === 0 && <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">No profiles found.</p>}
        </div>

        <p className={`mt-2 text-xs ${(listError || selectorError) ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`} role={(listError || selectorError) ? 'alert' : undefined}>
          {listError ?? selectorError ?? 'Only active profiles appear in the sidebar profile selector.'}
        </p>
      </section>

      {drawerMode && (
        <div className="fixed inset-0 z-50" role="presentation">
          <button type="button" aria-label="Close profile settings" onClick={() => !isSaving && !isDrafting && setDrawerMode(null)} className="absolute inset-0 bg-black/35" />
          <aside role="dialog" aria-modal="true" aria-labelledby="profile-settings-title" className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="min-w-0">
                <h2 id="profile-settings-title" className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {drawerMode === 'create' ? 'Create a profile' : editingProfile?.displayName}
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {drawerMode === 'create' ? `Guided builder · Step ${builderStep + 1} of ${BUILDER_STEPS.length}` : 'Purpose, soul, and capabilities'}
                </p>
              </div>
              <button type="button" onClick={() => setDrawerMode(null)} disabled={isSaving || isDrafting} aria-label="Close profile settings" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                <X size={16} />
              </button>
            </div>

            {isLoadingSettings && !settings ? (
              <div className="flex flex-1 items-center justify-center text-zinc-500 dark:text-zinc-400"><Loader2 size={20} className="animate-spin" aria-label="Loading profile settings" /></div>
            ) : settings ? (
              <form onSubmit={saveSettings} className="flex min-h-0 flex-1 flex-col">
                <div className="flex-1 overflow-y-auto px-5 py-5">
                  {drawerMode === 'create' ? (
                    <>
                      <div className="mb-5 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40">
                        <label className="block">
                          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Describe this profile</span>
                          <textarea
                            value={draftDescription}
                            onChange={(event) => setDraftDescription(event.target.value)}
                            rows={3}
                            maxLength={2000}
                            disabled={isDrafting || isSaving}
                            placeholder="For example: A careful research partner that compares primary sources, flags uncertainty, and writes concise briefs."
                            className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                          />
                        </label>
                        <div className="mt-2.5 flex items-center justify-between gap-3">
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">Hermes drafts the fields below. Nothing is created until you save.</p>
                          <button
                            type="button"
                            onClick={() => void draftProfile()}
                            disabled={isDrafting || isSaving || !draftDescription.trim()}
                            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            {isDrafting ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                            {isDrafting ? 'Drafting…' : 'Draft with Hermes'}
                          </button>
                        </div>
                      </div>

                      <div className="mb-5 grid grid-cols-3 gap-2" aria-label="Profile builder steps">
                        {BUILDER_STEPS.map((step, index) => (
                          <button
                            key={step}
                            type="button"
                            onClick={() => setBuilderStep(index)}
                            disabled={isDrafting || isSaving}
                            className={`rounded-lg border px-2 py-2 text-xs font-medium ${index === builderStep ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900' : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
                          >
                            {index + 1}. {step}
                          </button>
                        ))}
                      </div>
                      <section aria-labelledby={`builder-step-${builderStep}`} className="space-y-4">
                        <div>
                          <h3 id={`builder-step-${builderStep}`} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{BUILDER_STEPS[builderStep]}</h3>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {builderStep === 0 && 'Name the profile and define the work it owns.'}
                            {builderStep === 1 && 'Shape how the profile thinks, communicates, and makes decisions.'}
                            {builderStep === 2 && 'Choose its model and reasoning defaults.'}
                          </p>
                        </div>
                        {builderStep === 0 && purposeFields}
                        {builderStep === 1 && soulFields}
                        {builderStep === 2 && capabilityFields}
                      </section>
                    </>
                  ) : (
                    <div className="space-y-3">
                      <EditSection title="Purpose" summary={settings.description || settings.displayName}>{purposeFields}</EditSection>
                      <EditSection title="Soul" summary={settings.soul.trim() ? 'Identity and operating principles configured' : 'No SOUL.md content yet'}>{soulFields}</EditSection>
                      <EditSection title="Capabilities" summary={settings.model ? `${settings.provider ? `${settings.provider} · ` : ''}${settings.model}` : 'Uses Hermes defaults'}>{capabilityFields}</EditSection>

                      {editingProfile && !editingProfile.isDefault && (
                        <details className="group rounded-xl border border-red-200 bg-red-50/40 dark:border-red-950 dark:bg-red-950/10">
                          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 text-red-700 [&::-webkit-details-marker]:hidden dark:text-red-300">
                            <ChevronRight size={15} className="transition-transform group-open:rotate-90" />
                            <span className="text-sm font-medium">Delete profile</span>
                          </summary>
                          <div className="space-y-3 border-t border-red-200 px-4 py-4 dark:border-red-950">
                            <p className="text-xs leading-5 text-red-700 dark:text-red-300">A backup is created first. The profile and its Olympus Dispatch tasks are then removed.</p>
                            {editingProfile.id === activeProfileId ? (
                              <p className="text-xs font-medium text-red-700 dark:text-red-300">Switch to another profile before deleting the current profile.</p>
                            ) : (
                              <>
                                <label className="block">
                                  <span className="text-xs font-medium text-red-800 dark:text-red-200">Type <code>{editingProfile.id}</code> to confirm</span>
                                  <input
                                    value={deleteConfirmation}
                                    onChange={(event) => setDeleteConfirmation(event.target.value)}
                                    disabled={isSaving || isDrafting}
                                    autoComplete="off"
                                    className="mt-1.5 w-full rounded-lg border border-red-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-red-200 dark:border-red-900 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:ring-red-950"
                                  />
                                </label>
                                <button type="button" onClick={() => void deleteProfile()} disabled={isSaving || deleteConfirmation !== editingProfile.id} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">
                                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete profile
                                </button>
                              </>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {drawerError && <p className="mt-4 text-sm text-red-500" role="alert">{drawerError}</p>}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                  <div>
                    {drawerMode === 'create' && builderStep > 0 && (
                      <button type="button" onClick={() => setBuilderStep((step) => step - 1)} disabled={isSaving || isDrafting} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Back</button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setDrawerMode(null)} disabled={isSaving || isDrafting} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Cancel</button>
                    {drawerMode === 'create' && builderStep < BUILDER_STEPS.length - 1 ? (
                      <button type="button" onClick={() => setBuilderStep((step) => step + 1)} disabled={isDrafting || isSaving || (builderStep === 0 && (!settings.displayName.trim() || !settings.id.trim()))} className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">Next</button>
                    ) : (
                      <button type="submit" disabled={isSaving || isDrafting} className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
                        {isSaving && <Loader2 size={14} className="animate-spin" />}
                        {isSaving ? 'Saving…' : (drawerMode === 'create' ? 'Save profile' : 'Save changes')}
                      </button>
                    )}
                  </div>
                </div>
              </form>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
                <p className="text-sm text-red-500" role="alert">{drawerError ?? 'Profile settings are unavailable.'}</p>
                {editingProfile && <button type="button" onClick={() => void openEditor(editingProfile)} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Try again</button>}
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
