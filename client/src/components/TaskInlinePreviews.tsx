import { useEffect, useRef, useState } from 'react';
import { Check, Download, Expand, Loader2, Monitor, Smartphone } from 'lucide-react';
import type { TaskAttachment, TaskDraftSelection } from '@shared/types';
import { fetchTaskDraftSelections, saveTaskDraftSelection, taskArtifactPreviewUrl } from '../lib/api';
import { toErrorMessage } from '../lib/format';

const button = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800';
type PreviewAttachment = TaskAttachment & { preview: NonNullable<TaskAttachment['preview']> };

function InlineArtifact({ taskId, attachment, compact = false }: { taskId: string; attachment: PreviewAttachment; compact?: boolean }) {
  const { preview } = attachment;
  const url = taskArtifactPreviewUrl(taskId, preview.id);
  const [device, setDevice] = useState<'responsive' | 'desktop' | 'mobile'>('responsive');
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(640);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetch(url, { method: 'HEAD', signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error('Preview is unavailable. The original download may still be available.');
    }).catch((err) => { if (!controller.signal.aborted) setError(toErrorMessage(err, 'Preview could not load.')); });
    return () => controller.abort();
  }, [url]);
  const frameWidth = device === 'desktop' ? 1280 : device === 'mobile' ? 390 : width;
  const scale = Math.min(1, width / frameWidth);
  const frameHeight = expanded ? 900 : compact ? 420 : 620;
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {preview.kind === 'html' ? <div role="group" aria-label={`${preview.title} viewport`} className="flex flex-wrap gap-1">
          {(['responsive', 'desktop', 'mobile'] as const).map((mode) => <button key={mode} type="button" className={button} aria-pressed={device === mode} onClick={() => setDevice(mode)}>
            {mode === 'mobile' ? <Smartphone size={12} /> : <Monitor size={12} />}{mode === 'responsive' ? 'Fit' : mode === 'desktop' ? 'Desktop' : 'Mobile'}
          </button>)}
        </div> : <span className="text-xs text-zinc-500">Image preview</span>}
        <div className="flex gap-1">
          <button type="button" className={button} onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={`${expanded ? 'Reduce' : 'Enlarge'} ${preview.title}`}><Expand size={12} />{expanded ? 'Reduce' : 'Enlarge'}</button>
          <a className={button} href={`${url}&download=1`} download={attachment.name} aria-label={`Download ${preview.title}`}><Download size={12} /></a>
        </div>
      </div>
      <div ref={container} className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700">
        {error ? <p role="alert" className="p-4 text-sm text-red-600">{error}</p> : preview.kind === 'image' ? (
          <img src={url} alt={preview.title} loading="lazy" onError={() => setError('Image preview could not load.')} className={`mx-auto w-full object-contain ${expanded ? 'max-h-[85vh]' : compact ? 'max-h-64' : 'max-h-[520px]'}`} />
        ) : <div style={{ height: frameHeight * scale, maxWidth: '100%' }}>
          <iframe title={`${preview.title} interactive preview`} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy"
            style={{ width: frameWidth, height: frameHeight, transform: `scale(${scale})`, transformOrigin: 'top left', border: 0 }} />
        </div>}
      </div>
      {preview.kind === 'html' && <p className="mt-1.5 text-[11px] text-zinc-500">Isolated HTML prototype · external resources and API requests are blocked.</p>}
    </div>
  );
}

function DraftGroup({ taskId, drafts, onDraftPrompt }: { taskId: string; drafts: PreviewAttachment[]; onDraftPrompt?: (prompt: string) => void }) {
  const groupId = drafts[0].preview.groupId!;
  const [selection, setSelection] = useState<TaskDraftSelection | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = () => {
    const request = ++generation.current;
    setLoaded(false);
    void fetchTaskDraftSelections(taskId).then(({ selections }) => {
      if (request !== generation.current) return;
      const saved = selections.find((item) => item.groupId === groupId) ?? null;
      setSelection(saved); setFeedback(saved?.feedback ?? ''); setError(null); setLoaded(true);
    }).catch((err) => { if (request === generation.current) setError(toErrorMessage(err, 'Could not load the saved choice.')); });
  };
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [taskId, groupId]);
  const choose = async (draft: PreviewAttachment, refine: boolean) => {
    if (busyRef.current || !loaded || !onDraftPrompt) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    const request = generation.current;
    try {
      const result = await saveTaskDraftSelection(taskId, { groupId, previewId: draft.preview.id, feedback: refine ? feedback.trim() || 'Please ask what I would like to change before refining this draft.' : feedback.trim() });
      if (request !== generation.current) return;
      setSelection(result.selection);
      onDraftPrompt(result.selection.prompt);
      setNotice('Choice saved. Your follow-up is in the message box—send it to continue. This does not approve deployment.');
    } catch (err) { if (request === generation.current) setError(toErrorMessage(err, 'Could not save this choice.')); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const shown = focus ? drafts.filter((draft) => draft.preview.id === focus) : drafts;
  return <section aria-label={drafts[0].preview.groupTitle || 'Design directions'} className="my-4 min-w-0 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-700 dark:bg-zinc-900/30">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{drafts[0].preview.groupTitle || 'Design directions'}</h3><p className="text-xs text-zinc-500">Compare concepts, choose a direction, then continue in chat.</p></div>
      <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">Design concept · not a verified build</span>
    </div>
    <div role="group" aria-label="Compare design drafts" className="mb-3 flex flex-wrap gap-1">
      <button type="button" className={button} aria-pressed={!focus} onClick={() => setFocus(null)}>Compare all</button>
      {drafts.map((draft) => <button type="button" key={draft.preview.id} className={button} aria-pressed={focus === draft.preview.id} onClick={() => setFocus(draft.preview.id)}>{draft.preview.draftId?.toUpperCase()} · {draft.preview.title}</button>)}
    </div>
    <div className={`grid min-w-0 gap-3 ${!focus && drafts.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
      {shown.map((draft) => <article key={draft.preview.id} className={`min-w-0 rounded-xl border bg-white p-3 dark:bg-zinc-950 ${selection?.previewId === draft.preview.id ? 'border-emerald-500 ring-1 ring-emerald-500' : 'border-zinc-200 dark:border-zinc-700'}`}>
        <div className="mb-2 flex items-start justify-between gap-2"><h4 className="font-medium text-zinc-900 dark:text-zinc-100">{draft.preview.draftId?.toUpperCase()} · {draft.preview.title}</h4>{selection?.previewId === draft.preview.id && <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><Check size={12} />Selected</span>}</div>
        {draft.preview.description && <p className="mb-3 text-xs text-zinc-500">{draft.preview.description}</p>}
        <InlineArtifact taskId={taskId} attachment={draft} compact={!focus} />
        {onDraftPrompt && <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !loaded} onClick={() => void choose(draft, false)}>{busy && <Loader2 size={12} className="animate-spin" />}Use this direction</button><button type="button" className={button} disabled={busy || !loaded} onClick={() => void choose(draft, true)}>Refine this draft</button></div>}
      </article>)}
    </div>
    {onDraftPrompt && <label className="mt-3 block text-xs text-zinc-600 dark:text-zinc-400">Optional feedback—such as “B’s layout with A’s typography”<textarea rows={2} maxLength={2000} value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={busy} className="mt-1 w-full resize-y rounded-lg border border-zinc-200 bg-white p-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200" /></label>}
    {notice && <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{notice}</p>}
    {error && <div role="alert" className="mt-2 text-xs text-red-600">{error}{!loaded && <button type="button" className={`${button} ml-2`} onClick={refresh}>Retry</button>}</div>}
  </section>;
}

export function TaskInlinePreviews({ taskId, attachments, onDraftPrompt }: { taskId: string; attachments: TaskAttachment[]; onDraftPrompt?: (prompt: string) => void }) {
  const previews = attachments.filter((attachment): attachment is PreviewAttachment => !!attachment.preview);
  if (!previews.length) return null;
  const groups = new Map<string, PreviewAttachment[]>();
  for (const item of previews) {
    const key = item.preview.groupId || item.preview.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return <div className="min-w-0" aria-label="Inline previews">{[...groups.entries()].map(([id, items]) => items[0].preview.groupId
    ? <DraftGroup key={`${taskId}:${id}`} taskId={taskId} drafts={items} onDraftPrompt={onDraftPrompt} />
    : <section key={id} className="my-4 min-w-0 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700"><h3 className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">{items[0].preview.title}</h3><InlineArtifact taskId={taskId} attachment={items[0]} /></section>)}</div>;
}
