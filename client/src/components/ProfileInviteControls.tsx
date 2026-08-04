import { X } from 'lucide-react';
import type { ActiveProfileMention, ProfileMentionOption } from '../lib/profileMentions';

export interface ProfileInviteOption extends ProfileMentionOption {
  description?: string | null;
}

interface ProfileInviteControlsProps<T extends ProfileInviteOption> {
  selected: T[];
  activeMention: ActiveProfileMention | null;
  highlightedIndex: number;
  showSelected?: boolean;
  showPicker?: boolean;
  onSelect: (profile: T) => void;
  onRemove: (profileId: string) => void;
}

export function ProfileInviteControls<T extends ProfileInviteOption>({
  selected,
  activeMention,
  highlightedIndex,
  showSelected = true,
  showPicker = true,
  onSelect,
  onRemove,
}: ProfileInviteControlsProps<T>) {
  return (
    <>
      {showSelected && selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3" aria-label="Invited profiles">
          {selected.map((profile) => (
            <span
              key={profile.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 dark:border-violet-900/70 dark:bg-violet-950/40 dark:text-violet-300"
            >
              <span className="truncate">{profile.label}</span>
              <button
                type="button"
                onClick={() => onRemove(profile.id)}
                aria-label={`Remove ${profile.label} from collaboration`}
                title="Remove collaborator"
                className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-violet-400 hover:bg-violet-200 hover:text-violet-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:hover:bg-violet-900 dark:hover:text-violet-100"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {showPicker && activeMention && activeMention.options.length > 0 && (
        <div
          className="mx-4 mb-2 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          role="listbox"
          aria-label="Invite a profile"
        >
          {activeMention.options.slice(0, 9).map((profile, index) => {
            const option = profile as T;
            const selectedAlready = selected.some((item) => item.id === option.id);
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(option)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
                  index === highlightedIndex
                    ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800'
                }`}
              >
                <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-zinc-200 bg-zinc-50 px-1 text-[10px] font-semibold text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-zinc-400 dark:text-zinc-500">
                    {option.description || option.id}
                  </span>
                </span>
                {selectedAlready && (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-violet-500 dark:text-violet-400">
                    Invited
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
