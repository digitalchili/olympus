import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ArrowUp, FolderKanban, Loader2, UserRound } from 'lucide-react';
import { InputToolbar } from './InputToolbar';
import { AttachButton, AttachDropOverlay, AttachmentTray, UploadErrorBar } from './ChatAttachments';
import { createTask, fetchHermesProfiles, fetchProjects, type HermesProfile } from '../lib/api';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { useFileAttachments } from '../hooks/useFileAttachments';
import { isEditableTarget, handleChatKeyDown, toggleRunMode } from '../lib/keyboard';
import { GOAL_MODE_PLACEHOLDER, toErrorMessage } from '../lib/format';
import { createUuid } from '../lib/uuid';
import {
  addProfileInvite,
  applyProfileMentionSelection,
  findActiveProfileMention,
  numericProfileSelectionIndex,
  removeProfileInvite,
  type ActiveProfileMention,
} from '../lib/profileMentions';
import { ProfileInviteControls } from './ProfileInviteControls';
import type { ChatRunMode, ProjectSummary } from '@shared/types';
import { useProfile } from '../contexts/ProfileContext';
import { toWithProfile } from '../lib/profileQuery';

type NewTaskLocationState = {
  draft?: string;
} | null;

function draftFromLocationState(state: unknown): string {
  const draft = (state as NewTaskLocationState)?.draft;
  return typeof draft === 'string' ? draft : '';
}

export function NewTaskPage() {
  const navigate = useNavigate();
  const { activeProfileId, profiles: allProfiles } = useProfile();
  const location = useLocation();
  const initialProjectId = new URLSearchParams(location.search).get('project') ?? '';
  const projectLocked = Boolean(initialProjectId);
  const initialDraftRef = useRef(draftFromLocationState(location.state));
  const lastAppliedKeyRef = useRef(location.key);
  const [input, setInput] = useState(initialDraftRef.current);
  const [runMode, setRunMode] = useState<ChatRunMode>('task');
  const [isCreating, setIsCreating] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [inboxHandlerId, setInboxHandlerId] = useState(activeProfileId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const projectSelectionPending = projectLocked && !selectedProject;
  const handlerProfileId = selectedProject?.managerProfileId ?? inboxHandlerId;
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<HermesProfile[]>([]);
  const [activeMention, setActiveMention] = useState<ActiveProfileMention | null>(null);
  const [highlightedProfileIndex, setHighlightedProfileIndex] = useState(0);
  const { defaults, modelGroups, model, setModel, provider, setProvider, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const uploadBucketRef = useRef<string | null>(null);
  if (uploadBucketRef.current === null) uploadBucketRef.current = `draft-${createUuid()}`;
  const uploadBucketId = uploadBucketRef.current;
  const {
    pendingFiles,
    dragOver,
    uploadError,
    setUploadError,
    hasUploadingFiles,
    uploadBlocksSend,
    sendBlockedLabel,
    addFiles,
    removeFile,
    retryFile,
    restoreTextFile,
    submitWithAttachments,
    dragHandlers,
    handlePaste,
  } = useFileAttachments(uploadBucketId, { value: input, setValue: (value) => { setInput(value); setActiveMention(null); }, inputRef });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then(({ projects: nextProjects }) => {
        if (!cancelled) setProjects(nextProjects);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    fetchHermesProfiles()
      .then(({ profiles: nextProfiles }) => {
        if (!cancelled) {
          setProfiles(nextProfiles.filter((profile) => profile.active && profile.id !== handlerProfileId));
        }
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [handlerProfileId]);

  useEffect(() => {
    setSelectedProfiles((current) => current.filter((profile) => profile.id !== handlerProfileId));
  }, [handlerProfileId]);

  const updateInput = useCallback((nextInput: string, cursor?: number | null) => {
    setInput(nextInput);
    const nextMention = findActiveProfileMention(nextInput, cursor ?? nextInput.length, profiles);
    setActiveMention(nextMention);
    setHighlightedProfileIndex(0);
  }, [profiles]);

  useEffect(() => {
    if (lastAppliedKeyRef.current === location.key) return;
    lastAppliedKeyRef.current = location.key;
    const nextDraft = draftFromLocationState(location.state);
    if (!nextDraft) return;
    setInput(nextDraft);
    inputRef.current?.focus();
  }, [location.key, location.state]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) navigate(toWithProfile('/', activeProfileId));
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeProfileId, navigate]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || isCreating || (!defaults && isLoading) || uploadBlocksSend || projectSelectionPending) return;
    if (runMode === 'goal' && selectedProfiles.length > 0) {
      setUploadError('Remove invited profiles before starting Goal mode. Collaboration runs in Task mode.');
      return;
    }

    setIsCreating(true);
    setUploadError(null);
    try {
      const description = text || pendingFiles.map((f) => f.file.name).join(', ');
      const { task } = await createTask(description, undefined, null, {
        projectId: selectedProject?.id ?? null,
        handlingProfileId: selectedProject ? null : handlerProfileId,
        routingProfileId: handlerProfileId,
      });
      const initialMessage = submitWithAttachments(text);
      const taskPath = selectedProject
        ? `/projects/${encodeURIComponent(selectedProject.id)}/tasks/${encodeURIComponent(task.id)}`
        : `/tasks/${encodeURIComponent(task.id)}`;
      navigate(toWithProfile(taskPath, task.handling_profile_id ?? handlerProfileId), {
        state: {
          initialMessage,
          initialSettings: selectedProject
            ? { mode: runMode }
            : { model, provider, reasoningEffort, mode: runMode },
          initialInvitedProfileIds: selectedProfiles.map((profile) => profile.id),
        },
      });
    } catch (err) {
      setUploadError(toErrorMessage(err, 'Failed to create task'));
      setIsCreating(false);
    }
  }, [defaults, handlerProfileId, uploadBlocksSend, input, isCreating, isLoading, model, navigate, pendingFiles, projectSelectionPending, provider, reasoningEffort, runMode, selectedProfiles, selectedProject, submitWithAttachments, setUploadError]);

  const selectMentionProfile = useCallback((profile: HermesProfile) => {
    if (!activeMention) return;
    const next = applyProfileMentionSelection(input, activeMention, profile);
    setInput(next.text);
    setSelectedProfiles((current) => {
      if (current.some((item) => item.id === profile.id)) return current;
      if (current.length >= 9) {
        setUploadError('You can invite up to 9 profiles.');
        return current;
      }
      return addProfileInvite(current, profile);
    });
    setActiveMention(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }, [activeMention, input]);

  const handleToggleGoalMode = useCallback(() => setRunMode(toggleRunMode), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (activeMention && activeMention.options.length > 0) {
        const numericIndex = !e.metaKey && !e.ctrlKey && !e.altKey
          ? numericProfileSelectionIndex(e.key, Math.min(activeMention.options.length, 9))
          : null;
        if (numericIndex !== null) {
          e.preventDefault();
          const profile = activeMention.options[numericIndex] as HermesProfile | undefined;
          if (profile) selectMentionProfile(profile);
          return;
        }
        const optionCount = Math.min(activeMention.options.length, 9);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedProfileIndex((index) => (index + 1) % optionCount);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedProfileIndex((index) => (index - 1 + optionCount) % optionCount);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const profile = activeMention.options[highlightedProfileIndex] as HermesProfile | undefined;
          if (profile) selectMentionProfile(profile);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setActiveMention(null);
          return;
        }
      }
      handleChatKeyDown(e, handleSubmit, {
        onGoalToggle: handleToggleGoalMode,
        goalToggleDisabled: isCreating || selectedProfiles.length > 0,
      });
    },
    [activeMention, handleSubmit, handleToggleGoalMode, highlightedProfileIndex, isCreating, selectMentionProfile, selectedProfiles.length],
  );

  return (
    <div className="relative flex-1 flex flex-col items-center justify-center px-6 pb-24" {...(isCreating ? {} : dragHandlers)}>
      {dragOver && !isCreating && <AttachDropOverlay />}
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6">
        What do you need done?
      </h1>

      <div className="w-full max-w-4xl">
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-sm">
          <ProfileInviteControls
            selected={selectedProfiles}
            activeMention={null}
            highlightedIndex={highlightedProfileIndex}
            showPicker={false}
            onSelect={selectMentionProfile}
            onRemove={(profileId) => setSelectedProfiles((current) => removeProfileInvite(current, profileId))}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => updateInput(e.target.value, e.target.selectionStart)}
            onClick={(e) => updateInput(input, e.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            onPaste={isCreating ? undefined : handlePaste}
            placeholder={runMode === 'goal' ? GOAL_MODE_PLACEHOLDER : 'Describe what you want to accomplish… Type @ to invite profiles'}
            rows={4}
            className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <ProfileInviteControls
            selected={selectedProfiles}
            activeMention={activeMention}
            highlightedIndex={highlightedProfileIndex}
            showSelected={false}
            onSelect={selectMentionProfile}
            onRemove={() => {}}
          />
          <AttachmentTray files={pendingFiles} onRemove={removeFile} onRetry={retryFile} onRestoreText={restoreTextFile} />
          {uploadError && <UploadErrorBar error={uploadError} onDismiss={() => setUploadError(null)} />}
          <div className="flex items-end justify-between gap-2 px-3 pb-3 sm:gap-3 sm:px-4">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <AttachButton onFiles={addFiles} disabled={isCreating} />
              <label className="inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <FolderKanban size={14} className="shrink-0" />
                <span className="shrink-0">Project</span>
                <select
                  aria-label="Project"
                  value={selectedProjectId}
                  disabled={projectLocked || isCreating}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                  className="min-w-0 max-w-40 bg-transparent text-xs font-medium outline-none disabled:cursor-not-allowed disabled:text-zinc-400 sm:max-w-52"
                >
                  <option value="">No project</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label
                title={selectedProject ? 'Future tasks use the Project manager policy' : 'Choose the Profile that will handle this task'}
                className="inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                <UserRound size={14} className="shrink-0" />
                <span className="shrink-0">Profile</span>
                <select
                  aria-label="Profile"
                  value={handlerProfileId}
                  disabled={Boolean(selectedProject) || isCreating}
                  onChange={(event) => setInboxHandlerId(event.target.value)}
                  className="min-w-0 max-w-32 bg-transparent text-xs font-medium outline-none disabled:cursor-not-allowed disabled:text-zinc-400 sm:max-w-44"
                >
                  {selectedProject ? (
                    <option value={selectedProject.managerProfileId}>{selectedProject.manager.displayName}</option>
                  ) : (
                    allProfiles.filter((profile) => profile.active).map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)
                  )}
                </select>
              </label>
              <InputToolbar
                model={model}
                provider={provider}
                reasoningEffort={reasoningEffort}
                runMode={runMode}
                defaults={defaults}
                modelGroups={modelGroups}
                disabled={isCreating}
                compactMobile
                onModelChange={(nextModel, nextProvider) => {
                  setModel(nextModel);
                  setProvider(nextProvider ?? null);
                }}
                onReasoningEffortChange={setReasoningEffort}
                onRunModeChange={(nextMode) => {
                  if (nextMode === 'goal' && selectedProfiles.length > 0) {
                    setUploadError('Remove invited profiles before starting Goal mode.');
                    return;
                  }
                  setRunMode(nextMode);
                }}
              />
            </div>
            <button
              onClick={handleSubmit}
              disabled={(!input.trim() && pendingFiles.length === 0) || isCreating || (!defaults && isLoading) || uploadBlocksSend || projectSelectionPending}
              title={projectSelectionPending ? 'Waiting for Project' : sendBlockedLabel ?? 'Send message'}
              aria-label={projectSelectionPending ? 'Waiting for Project' : sendBlockedLabel ?? 'Send message'}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {isCreating || hasUploadingFiles ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-3">
          The more context you give, the better your assistant will do.
        </p>
      </div>
    </div>
  );
}
