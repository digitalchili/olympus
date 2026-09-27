import { useState, useCallback, useEffect, useRef, type SetStateAction } from 'react';
import { fetchAgentDefaults, fetchAgentModels, fetchTaskAgentSettings } from '../lib/api';
import type { AgentRunSettings } from '../lib/api';
import { readCachedAgentDefaults, writeCachedAgentDefaults } from '../lib/agentDefaultsCache';
import { activeProfileIdFromWindow } from '../lib/profileQuery';
import type { AgentDefaults, AgentModelGroup, ReasoningEffort } from '@shared/types';

type Choices = { model: string | null; provider: string | null; reasoningEffort: ReasoningEffort | null };
export function useAgentConfig(taskId?: string, initialSettings?: AgentRunSettings, profileId = activeProfileIdFromWindow()) {
  const scope = JSON.stringify([profileId, taskId]);
  const context = useRef({ scope, initialSettings, edited: new Set<keyof Choices>(), defaultsRevision: 0, appliedRevision: 0 });
  if (context.current.scope !== scope) context.current = { scope, initialSettings, edited: new Set(), defaultsRevision: 0, appliedRevision: 0 };
  const initial = () => ({ scope, defaults: readCachedAgentDefaults(profileId),
    model: initialSettings?.model ?? null, provider: initialSettings?.provider ?? null,
    reasoningEffort: initialSettings?.reasoningEffort ?? null, isLoading: true, settingsError: null as string | null });
  const [settings, setSettings] = useState(initial);
  const [catalog, setCatalog] = useState({ scope, groups: [] as AgentModelGroup[], loading: true });
  const [retry, setRetry] = useState(0);
  // A changed scope is pending immediately, before its effects run.
  const current = settings.scope === scope ? settings : initial();

  useEffect(() => {
    let cancelled = false;
    const owner = context.current;
    const revision = ++owner.defaultsRevision;
    setSettings(previous => previous.scope === scope
      ? { ...previous, isLoading: true, settingsError: null } : initial());
    const request = taskId ? fetchTaskAgentSettings(taskId, profileId) : fetchAgentDefaults(profileId);
    void request.then(value => {
      if (cancelled || context.current !== owner) return;
      const defaults = 'task' in value ? value.defaults : value;
      const applyDefaults = revision >= owner.appliedRevision;
      if (applyDefaults) { owner.appliedRevision = revision; writeCachedAgentDefaults(defaults, profileId); }
      setSettings(previous => {
        if (previous.scope !== scope) return previous;
        const next = { ...previous, defaults: applyDefaults ? defaults : previous.defaults, isLoading: false, settingsError: null };
        if ('task' in value) {
          for (const field of ['model', 'provider', 'reasoningEffort'] as const) {
            if (!owner.edited.has(field)) Object.assign(next, { [field]: value.task[field] ?? owner.initialSettings?.[field] ?? null });
          }
        }
        return next;
      });
    }).catch(() => {
      if (!cancelled && context.current === owner) setSettings(previous => ({ ...previous,
        isLoading: false, settingsError: 'Could not load the saved settings. Retry before sending.' }));
    });
    return () => { cancelled = true; };
  }, [scope, retry]);

  useEffect(() => {
    let cancelled = false, catalogRequest = 0;
    const owner = context.current;
    const loadModels = () => {
      const request = ++catalogRequest;
      setCatalog(previous => ({ scope, groups: previous.scope === scope ? previous.groups : [], loading: true }));
      void fetchAgentModels(profileId).then(result => {
        if (!cancelled && context.current === owner && request === catalogRequest) setCatalog({ scope, groups: result.groups, loading: false });
      }).catch(() => {
        if (!cancelled && context.current === owner && request === catalogRequest) setCatalog(previous => ({ ...previous, loading: false }));
      });
    };
    const refresh = () => {
      loadModels();
      const revision = ++owner.defaultsRevision;
      void fetchAgentDefaults(profileId).then(defaults => {
        if (cancelled || context.current !== owner || revision < owner.appliedRevision) return;
        owner.appliedRevision = revision;
        writeCachedAgentDefaults(defaults, profileId);
        setSettings(previous => previous.scope === scope ? { ...previous, defaults } : previous);
      }).catch(() => {});
    };
    loadModels();
    window.addEventListener('olympus:models-changed', refresh);
    return () => { cancelled = true; window.removeEventListener('olympus:models-changed', refresh); };
  }, [scope]);

  const change = useCallback(<K extends keyof Choices>(field: K, value: SetStateAction<Choices[K]>) => {
    if (context.current.scope !== scope) return;
    context.current.edited.add(field);
    setSettings(previous => previous.scope === scope ? { ...previous,
      [field]: typeof value === 'function' ? value(previous[field]) : value } : previous);
  }, [scope]);
  const setModel = useCallback((value: SetStateAction<string | null>) => change('model', value), [change]);
  const setProvider = useCallback((value: SetStateAction<string | null>) => change('provider', value), [change]);
  const setReasoningEffort = useCallback((value: SetStateAction<ReasoningEffort | null>) => change('reasoningEffort', value), [change]);
  const retrySettings = useCallback(() => setRetry(value => value + 1), []);
  const replaceDefaults = useCallback((defaults: AgentDefaults) => {
    if (context.current.scope !== scope) return;
    context.current.appliedRevision = ++context.current.defaultsRevision;
    writeCachedAgentDefaults(defaults, profileId);
    setSettings(previous => previous.scope === scope ? { ...previous, defaults } : previous);
  }, [scope]);

  return { ...current, modelGroups: catalog.scope === scope ? catalog.groups : [],
    isLoadingModels: catalog.scope !== scope || catalog.loading,
    setModel, setProvider, setReasoningEffort, retrySettings, replaceDefaults };
}
