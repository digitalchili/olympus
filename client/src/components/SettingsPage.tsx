import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Sun, Moon, Monitor, Volume2, VolumeX, Play } from 'lucide-react';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useSoundOnComplete } from '../hooks/useSoundOnComplete';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { updateAgentDefaults, updateInstallationName } from '../lib/api';
import { useStore } from '../lib/store';
import { toErrorMessage } from '../lib/format';
import { ProfilesSettings } from './ProfilesSettings';
import { ChannelSettings } from './ChannelSettings';
import { StorageSettings } from './StorageSettings';
import { UpdateSettings } from './UpdateSettings';
import { GitHubSettings } from './GitHubSettings';
import { ModelPicker, parseQualifiedModelValue, REASONING_LABELS, type ModelPickerSelection } from './InputToolbar';
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@shared/types';

export type SettingsTab = 'general' | 'profiles' | 'git' | 'integrations' | 'storage' | 'updates';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General Settings' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'git', label: 'Git Connections' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'storage', label: 'Storage' },
  { id: 'updates', label: 'Updates' },
];

function resolveTab(hash: string, searchTab: string | null): SettingsTab {
  if (searchTab && ['general', 'profiles', 'git', 'integrations', 'storage', 'updates'].includes(searchTab)) {
    return searchTab as SettingsTab;
  }
  const cleanHash = hash.replace(/^#/, '').toLowerCase();
  if (cleanHash === 'github' || cleanHash === 'git') return 'git';
  if (cleanHash === 'channels' || cleanHash === 'integrations') return 'integrations';
  if (cleanHash === 'storage') return 'storage';
  if (cleanHash === 'profiles') return 'profiles';
  if (cleanHash === 'updates') return 'updates';
  if (cleanHash === 'general') return 'general';
  return 'general';
}

type SegmentOption<T> = { value: T; label: string; icon: typeof Sun };

const themeOptions: SegmentOption<ThemePreference>[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

const soundOptions: SegmentOption<boolean>[] = [
  { value: false, label: 'Off', icon: VolumeX },
  { value: true, label: 'On', icon: Volume2 },
];

function SegmentedGroup<T>({ options, value, onChange }: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1 gap-1">
      {options.map(({ value: optValue, label, icon: Icon }) => (
        <button
          key={String(optValue)}
          onClick={() => onChange(optValue)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            value === optValue
              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
          }`}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { enabled: soundEnabled, setEnabled: setSoundEnabled, playPreview } = useSoundOnComplete();
  const installationName = useStore((state) => state.installationName);
  const setInstallationName = useStore((state) => state.setInstallationName);
  const [nameDraft, setNameDraft] = useState(installationName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const { defaults: agentDefaults, modelGroups, isLoading: isLoadingDefaults, replaceDefaults } = useAgentConfig();
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [savedDefaults, setSavedDefaults] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const activeTab = resolveTab(location.hash, searchParams.get('tab'));

  const selectTab = (nextTab: SettingsTab) => {
    const next = new URLSearchParams(searchParams);
    if (nextTab === 'general') {
      next.delete('tab');
    } else {
      next.set('tab', nextTab);
    }
    const searchString = next.toString();
    navigate({ search: searchString ? `?${searchString}` : '', hash: '' }, { replace: true });
  };

  useEffect(() => {
    if (!savedDefaults) return;
    const timer = setTimeout(() => setSavedDefaults(false), 2000);
    return () => clearTimeout(timer);
  }, [savedDefaults]);

  const saveDefaults = useCallback(async (updates: { provider?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) => {
    setSavingDefaults(true);
    setDefaultsError(null);
    setSavedDefaults(false);
    try {
      const result = await updateAgentDefaults(updates);
      replaceDefaults(result);
      setSavedDefaults(true);
    } catch (error) {
      setDefaultsError(toErrorMessage(error, 'Failed to save'));
    } finally {
      setSavingDefaults(false);
    }
  }, [replaceDefaults]);

  useEffect(() => {
    setNameDraft(installationName);
  }, [installationName]);

  const saveInstallationName = useCallback(async () => {
    const requestedName = nameDraft.trim() || 'Hermes';
    if (requestedName === installationName) {
      setNameDraft(requestedName);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const { name } = await updateInstallationName(requestedName);
      setInstallationName(name);
      setNameDraft(name);
    } catch (error) {
      setNameError(toErrorMessage(error, 'Failed to save name'));
    } finally {
      setSavingName(false);
    }
  }, [installationName, nameDraft, setInstallationName]);

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-3xl space-y-6">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => selectTab(tab.id)}
              className={`h-10 shrink-0 border-b-2 px-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === 'general' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Name</h2>
              <div className="max-w-sm">
                <input
                  value={nameDraft}
                  maxLength={80}
                  onChange={(event) => { setNameDraft(event.target.value); setNameError(null); }}
                  onBlur={saveInstallationName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
                  aria-label="Installation name"
                  placeholder="Hermes"
                  className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-800 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                />
                <p className={`mt-1.5 text-xs ${nameError ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`}>
                  {nameError ?? (savingName ? 'Saving…' : 'Shown beside the logo for this Hermes installation.')}
                </p>
              </div>
            </div>

            <section
              aria-labelledby="default-model-title"
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 id="default-model-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Default model
                  </h2>
                  <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
                    Model and reasoning effort for new tasks. Per-task overrides still apply.
                  </p>
                </div>
                <span
                  aria-live="polite"
                  aria-hidden={!defaultsError && !savingDefaults && !savedDefaults}
                  className={`shrink-0 text-xs transition-opacity duration-300 ${
                    defaultsError || savingDefaults || savedDefaults ? 'opacity-100' : 'opacity-0'
                  } ${defaultsError ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-500'}`}
                >
                  {defaultsError ?? (savingDefaults ? 'Saving...' : 'Saved')}
                </span>
              </div>

              <div className="mt-4 flex items-center flex-wrap gap-3">
                <ModelPicker
                  value={agentDefaults?.model ?? ''}
                  provider={agentDefaults?.provider ?? null}
                  modelGroups={modelGroups}
                  disabled={isLoadingDefaults || savingDefaults}
                  title={agentDefaults?.model ? `Default: ${agentDefaults.model}` : 'Select default model'}
                  onChange={(nextModel, selection?: ModelPickerSelection) => {
                    const parsed = parseQualifiedModelValue(nextModel);
                    const provider = selection?.provider ?? parsed?.provider;
                    saveDefaults({
                      model: parsed?.model ?? nextModel,
                      ...(provider ? { provider } : {}),
                    });
                  }}
                />

                <select
                  value={agentDefaults?.reasoningEffort ?? 'medium'}
                  disabled={isLoadingDefaults || savingDefaults}
                  onChange={(event) => saveDefaults({ reasoningEffort: event.target.value as ReasoningEffort })}
                  aria-label="Default reasoning effort"
                  className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 pr-7 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-700 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22none%22%20stroke%3D%22%2371717a%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m3%204.5%203%203%203-3%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat"
                >
                  {REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {REASONING_LABELS[effort]}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <div>
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Theme</h2>
              <SegmentedGroup options={themeOptions} value={theme} onChange={setTheme} />
            </div>

            <div>
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Sound on task completion</h2>
              <div className="flex items-center gap-2 flex-wrap">
                <SegmentedGroup options={soundOptions} value={soundEnabled} onChange={setSoundEnabled} />
                <button
                  onClick={playPreview}
                  aria-label="Preview sound"
                  title="Preview sound"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                >
                  <Play size={14} />
                  Preview
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'profiles' && (
          <ProfilesSettings />
        )}

        {activeTab === 'git' && (
          <GitHubSettings />
        )}

        {activeTab === 'integrations' && (
          <ChannelSettings />
        )}

        {activeTab === 'storage' && (
          <StorageSettings />
        )}

        {activeTab === 'updates' && (
          <UpdateSettings />
        )}
      </div>
    </div>
  );
}
