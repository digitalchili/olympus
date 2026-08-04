import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { ArrowUp, Loader2 } from 'lucide-react';
import { InputToolbar } from './InputToolbar';
import { AttachButton, AttachDropOverlay, AttachmentTray, UploadErrorBar } from './ChatAttachments';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { createTask, fetchHermesProfiles, type HermesProfile } from '../lib/api';
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
import type { ChatRunMode } from '@shared/types';
import { useProfile, useProfileNavigate } from '../contexts/ProfileContext';

type NewTaskLocationState = {
  draft?: string;
} | null;

function draftFromLocationState(state: unknown): string {
  const draft = (state as NewTaskLocationState)?.draft;
  return typeof draft === 'string' ? draft : '';
}

export function NewTaskPage() {
  const navigate = useProfileNavigate();
  const { activeProfileId } = useProfile();
  const location = useLocation();
  const initialDraftRef = useRef(draftFromLocationState(location.state));
  const lastAppliedKeyRef = useRef(location.key);
  const [input, setInput] = useState(initialDraftRef.current);
  const [runMode, setRunMode] = useState<ChatRunMode>('task');
  const [isCreating, setIsCreating] = useState(false);
  const [workdir, setWorkdir] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<HermesProfile[]>([]);
  const [activeMention, setActiveMention] = useState<ActiveProfileMention | null>(null);
  const [highlightedProfileIndex, setHighlightedProfileIndex] = useState(0);
  const { defaults, modelGroups, model, setModel, provider, setProvider, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig();
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
    submitWithAttachments,
    dragHandlers,
    handlePaste,
  } = useFileAttachments(uploadBucketId);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchHermesProfiles()
      .then(({ profiles: nextProfiles }) => {
        if (!cancelled) {
          setProfiles(nextProfiles.filter((profile) => profile.active && profile.id !== activeProfileId));
        }
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

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
      if (e.key === 'Escape' && !isEditableTarget(e.target)) navigate('/');
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || isCreating || (!defaults && isLoading) || uploadBlocksSend) return;
    if (runMode === 'goal' && selectedProfiles.length > 0) {
      setUploadError('Remove invited profiles before starting Goal mode. Collaboration runs in Task mode.');
      return;
    }

    setIsCreating(true);
    setUploadError(null);
    try {
      const description = text || pendingFiles.map((f) => f.file.name).join(', ');
      const { task } = await createTask(description, undefined, workdir);
      const initialMessage = submitWithAttachments(text);
      navigate(`/tasks/${task.id}`, {
        state: {
          initialMessage,
          initialSettings: { model, provider, reasoningEffort, mode: runMode },
          initialInvitedProfileIds: selectedProfiles.map((profile) => profile.id),
        },
      });
    } catch (err) {
      setUploadError(toErrorMessage(err, 'Failed to create task'));
      setIsCreating(false);
    }
  }, [defaults, uploadBlocksSend, input, isCreating, isLoading, model, navigate, pendingFiles, provider, reasoningEffort, runMode, selectedProfiles, submitWithAttachments, setUploadError, workdir]);

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

      <div className="w-full max-w-2xl">
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
          <AttachmentTray files={pendingFiles} onRemove={removeFile} onRetry={retryFile} />
          {uploadError && <UploadErrorBar error={uploadError} onDismiss={() => setUploadError(null)} />}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 sm:gap-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <AttachButton onFiles={addFiles} disabled={isCreating} />
              <ProjectFolderPicker value={workdir} onChange={setWorkdir} disabled={isCreating} />
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
              disabled={(!input.trim() && pendingFiles.length === 0) || isCreating || (!defaults && isLoading) || uploadBlocksSend}
              title={sendBlockedLabel ?? 'Send message'}
              aria-label={sendBlockedLabel ?? 'Send message'}
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
