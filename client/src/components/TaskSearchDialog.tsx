import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { searchTasks, type TaskSearchResult } from '../lib/api';

function roleLabel(role: TaskSearchResult['role']): string {
  return role === 'task' ? 'Task' : role.charAt(0).toUpperCase() + role.slice(1);
}

function HighlightedSnippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(/(<mark>|<\/mark>)/g);
  let highlighted = false;
  return (
    <span>
      {parts.map((part, index) => {
        if (part === '<mark>') { highlighted = true; return null; }
        if (part === '</mark>') { highlighted = false; return null; }
        return highlighted ? <mark key={index} className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/25">{part}</mark> : part;
      })}
    </span>
  );
}

export function TaskSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaskSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const openResult = useCallback((result: TaskSearchResult) => {
    navigate(`/tasks/${result.taskId}`);
    onClose();
  }, [navigate, onClose]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setError(null);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setLoading(false); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await searchTasks(query);
        if (!cancelled) setResults(response.results);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Search is unavailable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    setSelectedIndex(results.length ? 0 : -1);
    resultRefs.current = [];
  }, [results]);

  useEffect(() => {
    if (selectedIndex >= 0) resultRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!results.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => index < 0 ? 0 : (index + 1) % results.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => index <= 0 ? results.length - 1 : index - 1);
        return;
      }
      if (event.key === 'Enter' && selectedIndex >= 0) {
        event.preventDefault();
        openResult(results[selectedIndex]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, openResult, results, selectedIndex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-zinc-950/30 px-3 pt-[10vh] backdrop-blur-[1px] sm:pt-[14vh]" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Search tasks"
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-zinc-100 px-4 dark:border-zinc-800">
          <Search size={19} className="shrink-0 text-zinc-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-activedescendant={selectedIndex >= 0 ? `task-search-result-${selectedIndex}` : undefined}
            aria-controls="task-search-results"
            placeholder="Search every task and conversation…"
            className="h-14 min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
          />
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" aria-label="Close search">
            <X size={18} />
          </button>
        </div>
        <div id="task-search-results" role="listbox" className="max-h-[55vh] overflow-y-auto p-2">
          {query.trim().length < 2 && <p className="px-3 py-8 text-center text-sm text-zinc-400">Search task titles, descriptions, messages, and tool output.</p>}
          {loading && <p className="px-3 py-5 text-sm text-zinc-400">Searching…</p>}
          {error && <p className="px-3 py-5 text-sm text-red-500">{error}</p>}
          {!loading && !error && query.trim().length >= 2 && results.length === 0 && <p className="px-3 py-5 text-sm text-zinc-400">No matching task text.</p>}
          {results.map((result, index) => (
            <button
              key={`${result.taskId}-${result.role}-${index}`}
              id={`task-search-result-${index}`}
              ref={(element) => { resultRefs.current[index] = element; }}
              role="option"
              aria-selected={index === selectedIndex}
              type="button"
              onMouseMove={() => setSelectedIndex(index)}
              onClick={() => openResult(result)}
              className={`block w-full rounded-xl px-3 py-3 text-left transition-colors ${index === selectedIndex ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{result.taskTitle}</span>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{roleLabel(result.role)}</span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400"><HighlightedSnippet snippet={result.snippet} /></p>
            </button>
          ))}
        </div>
        <div className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400 dark:border-zinc-800">↑↓ to navigate · Enter to open · Esc to close</div>
      </section>
    </div>
  );
}
