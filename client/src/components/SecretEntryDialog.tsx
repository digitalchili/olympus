import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { parseProjectSecretInput, type ProjectSecretEntry } from '@shared/project-secrets';
import { fetchProjects, saveProjectSecrets } from '../lib/api';

export interface SecretEntryDraft {
  entries?: ProjectSecretEntry[];
  error?: string;
  name?: string;
}
interface Props {
  draft: SecretEntryDraft;
  projectId?: string | null;
  projectName?: string;
  taskId?: string;
  onClose: () => void;
  onSaved: (names: string[], projectId: string, projectName: string) => void;
}

function focusSecretEntry(form: HTMLFormElement) {
  const preferred = form.querySelector<HTMLElement>('select:not(:disabled), textarea:not(:disabled), button[type="submit"]:not(:disabled)');
  (preferred ?? form).focus();
}

export function SecretEntryDialog({ draft, projectId, projectName, taskId, onClose, onSaved }: Props) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState(projectId ?? '');
  const [entries, setEntries] = useState(draft.entries);
  const [text, setText] = useState(draft.name ? `${draft.name}=` : '');
  const [error, setError] = useState(draft.error ?? null);
  const [loading, setLoading] = useState(!projectId);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const form = dialogRef.current;
    if (!form) return;
    const previous = document.activeElement as HTMLElement | null;
    const containFocus = (event: FocusEvent) => {
      if (!form.contains(event.target as Node)) focusSecretEntry(form);
    };
    const containTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      event.preventDefault(); event.stopPropagation();
      const controls = Array.from(form.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled)'));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.shiftKey ? controls.at(-1) : controls[0])
        : controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
      (next ?? form).focus();
    };
    document.addEventListener('focusin', containFocus);
    document.addEventListener('keydown', containTab, true);
    focusSecretEntry(form);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', containTab, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useLayoutEffect(() => {
    if (dialogRef.current) focusSecretEntry(dialogRef.current);
  }, [loading, Boolean(entries)]);

  useEffect(() => {
    mounted.current = true;
    if (!projectId) void fetchProjects().then(result => {
      if (mounted.current) setProjects(result.projects.map(project => ({ id: project.id, name: project.name })));
    }).catch(() => {
      if (mounted.current) setError('Could not load projects. Close this window and try again.');
    }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [projectId]);

  async function save() {
    if (pending.current || !selectedId) return;
    const parsed = entries ? { kind: 'secrets' as const, entries } : parseProjectSecretInput(`/secrets\n${text}`);
    if (parsed.kind !== 'secrets') { setError(parsed.kind === 'invalid' ? parsed.error : 'Enter secrets as NAME=value, one per line.'); return; }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await saveProjectSecrets(selectedId, parsed.entries, taskId);
      if (mounted.current) {
        setText(''); setEntries(undefined);
        onSaved(result.savedNames, selectedId, projectName ?? projects.find(project => project.id === selectedId)?.name ?? 'this project');
      }
    } catch {
      if (mounted.current) setError('Could not save secrets. Check project access and try again. No message was sent to the assistant.');
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
    <form ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="secret-entry-title" onSubmit={event => { event.preventDefault(); void save(); }} className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
      <h2 id="secret-entry-title" className="text-base font-semibold">Save Project secrets</h2>
      <p className="mt-2 text-sm text-zinc-500">Values are stored in Project Settings → Secrets. They are not sent as a chat message. Saving an existing name replaces its value.</p>
      {projectId ? <p className="mt-3 text-sm font-medium">{projectName ?? 'This task’s project'}</p> : <label className="mt-3 block text-sm">Project<select aria-label="Project for secrets" value={selectedId} disabled={loading || saving} onChange={event => setSelectedId(event.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 dark:border-zinc-700"><option value="">{loading ? 'Loading projects…' : 'Choose a project'}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
      {entries ? <div className="mt-3"><p className="text-sm">Ready to save:</p><ul className="mt-1 space-y-1 font-mono text-xs">{entries.map(entry => <li key={entry.name}>{entry.name} <span className="text-zinc-400">••••••••</span></li>)}</ul><button type="button" disabled={saving} onClick={() => { setEntries(undefined); setText(''); setError(null); }} className="mt-2 text-xs underline">Enter different secrets</button></div> : <label className="mt-3 block text-sm">Keys and values<textarea aria-label="Secret entries" autoComplete="off" autoCorrect="off" spellCheck={false} value={text} disabled={saving} onChange={event => setText(event.target.value)} placeholder="NAME=value, one per line" rows={4} style={{ WebkitTextSecurity: 'disc' } as CSSProperties} className="mt-1 block w-full resize-y rounded-lg border border-zinc-200 bg-transparent p-2 font-mono text-sm dark:border-zinc-700" /></label>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={saving} onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">Cancel</button><button type="submit" disabled={saving || loading || !selectedId || (!entries && !text.trim())} className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{saving ? 'Saving…' : 'Save secrets'}</button></div>
    </form>
  </div>;
}
