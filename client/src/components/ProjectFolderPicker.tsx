import { useEffect, useState } from 'react';
import { ChevronLeft, FolderGit2, Loader2, X } from 'lucide-react';

type FolderEntry = { name: string; path: string };
type FolderResponse = { root: string; path: string; parentPath: string | null; directories: FolderEntry[] };

async function listFolders(path?: string): Promise<FolderResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await fetch(`/api/project-folders${query}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : 'Could not load project folders');
  }
  return response.json();
}

interface ProjectFolderPickerProps {
  value: string | null;
  disabled?: boolean;
  onChange: (path: string | null) => void;
}

export function ProjectFolderPicker({ value, disabled = false, onChange }: ProjectFolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<FolderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await listFolders(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load project folders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load(value ?? undefined);
  }, [open]);

  const label = value ? value.split('/').filter(Boolean).at(-1) ?? value : 'Select project folder';

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={value ?? 'Choose a project folder on the Minions host'}
        className="inline-flex h-9 max-w-[16rem] items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-700 sm:max-w-[20rem]"
      >
        <FolderGit2 size={16} className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Select project folder">
          <div className="w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Select project folder</h2>
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{data?.path ?? 'Loading folders on the Minions host...'}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close folder picker"><X size={17} /></button>
            </div>

            <div className="max-h-[50vh] overflow-y-auto p-2">
              {loading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500"><Loader2 size={16} className="animate-spin" /> Loading folders…</div>}
              {error && <p className="p-3 text-sm text-red-600">{error}</p>}
              {!loading && data?.parentPath && (
                <button type="button" onClick={() => void load(data.parentPath ?? undefined)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  <ChevronLeft size={16} /> Parent folder
                </button>
              )}
              {!loading && data?.directories.map((folder) => (
                <button key={folder.path} type="button" onClick={() => void load(folder.path)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800">
                  <FolderGit2 size={16} className="text-amber-500" />
                  <span className="truncate">{folder.name}</span>
                </button>
              ))}
              {!loading && data && data.directories.length === 0 && <p className="p-3 text-sm text-zinc-500">No subfolders here.</p>}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <button type="button" onClick={() => { onChange(null); setOpen(false); }} className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Use default workspace</button>
              <button type="button" disabled={!data || loading} onClick={() => { if (data) onChange(data.path); setOpen(false); }} className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">Use this folder</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
