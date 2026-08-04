import { Bot, Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { HermesProfile } from '@shared/types';

interface ProfilePickerProps {
  profiles: HermesProfile[];
  activeProfileId: string;
  loading: boolean;
  onChange: (profileId: string) => void;
}

export function ProfilePicker({ profiles, activeProfileId, loading, onChange }: ProfilePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => setOpen(false), [activeProfileId]);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        disabled={loading || profiles.length === 0}
        aria-label="Active Hermes profile"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={activeProfile ? `${activeProfile.label} · ${activeProfile.id}` : 'Choose Hermes profile'}
        onClick={() => setOpen((current) => !current)}
        className="group flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 text-left shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
          <Bot size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
            {activeProfile?.label ?? (loading ? 'Loading profiles…' : activeProfileId)}
          </span>
          {activeProfile && activeProfile.label !== activeProfile.id && (
            <span className="block truncate text-[10px] leading-3 text-zinc-400 dark:text-zinc-500">{activeProfile.id}</span>
          )}
        </span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Hermes profiles"
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl shadow-zinc-950/10 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/30"
        >
          <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Workspace profile
          </div>
          <div className="max-h-72 overflow-y-auto">
            {profiles.map((profile) => {
              const selected = profile.id === activeProfileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(profile.id);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
                    selected
                      ? 'bg-zinc-100 dark:bg-zinc-800'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/70'
                  }`}
                >
                  <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                    <Bot size={15} />
                    <span
                      title={profile.health.status === 'ready' ? 'Ready' : 'Needs attention'}
                      className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white dark:border-zinc-950 ${
                        profile.health.status === 'ready' ? 'bg-emerald-500' : 'bg-amber-500'
                      }`}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">{profile.label}</span>
                      {profile.isDefault && (
                        <span className="shrink-0 rounded bg-zinc-200/70 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300">
                          Default
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-zinc-400 dark:text-zinc-500">
                      {profile.description || profile.id}
                    </span>
                  </span>
                  <span className="flex size-5 shrink-0 items-center justify-center text-zinc-700 dark:text-zinc-200">
                    {selected && <Check size={14} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
