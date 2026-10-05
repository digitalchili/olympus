import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ArrowUpRight, CheckCheck, CircleAlert, Inbox, MessageCircle, RefreshCw } from 'lucide-react';
import { inboxTaskUrl, type InboxCategory, type InboxItem, type InboxPreview } from '@shared/inbox';
import { useInbox } from '../contexts/InboxContext';
import { fetchInboxPreview } from '../lib/api';
import { usePageHeader } from './Header';
import { MarkdownContent } from './MarkdownContent';

const categories: { id: InboxCategory; label: string; icon: typeof Inbox }[] = [
  { id: 'questions', label: 'Questions & approvals', icon: MessageCircle },
  { id: 'review', label: 'Ready for review', icon: CheckCheck },
  { id: 'help', label: 'Needs help', icon: CircleAlert },
];
const selectClass = 'min-w-0 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm dark:border-zinc-700';

export function InboxPage() {
  usePageHeader(useMemo(() => ({ crumbs: [{ label: 'Inbox' }] }), []));
  const { items, loading, error, refresh } = useInbox();
  const [profile, setProfile] = useState('');
  const [project, setProject] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const profiles = [...new Map(items.map(item => [item.profileId, item.profileName])).entries()];
  const projects = [...new Map(items.filter(item => item.projectId).map(item => [item.projectId!, item.projectName!])).entries()];
  const filtered = items.filter(item => (!profile || item.profileId === profile) && (!project || item.projectId === project));
  const selected = filtered.find(item => item.taskId === selectedId);
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-zinc-900 dark:text-zinc-100">
      <div className="border-b border-zinc-200 px-5 py-5 dark:border-zinc-800 sm:px-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">What needs you, across all profiles and projects.</p>
          </div>
          <button type="button" onClick={refresh} aria-label="Refresh Inbox" className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><RefreshCw size={17} /></button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select aria-label="Filter by profile" className={selectClass} value={profile} onChange={event => setProfile(event.target.value)}>
            <option value="">All profiles</option>
            {profile && !profiles.some(([id]) => id === profile) && <option value={profile}>Selected profile (no items)</option>}
            {profiles.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="Filter by project" className={selectClass} value={project} onChange={event => setProject(event.target.value)}>
            <option value="">All projects</option>
            {project && !projects.some(([id]) => id === project) && <option value={project}>Selected project (no items)</option>}
            {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          {!loading && !error && <span className="ml-auto text-xs text-zinc-500">{filtered.length} {filtered.length === 1 ? 'item' : 'items'}</span>}
        </div>
      </div>
      {error && <div role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Could not refresh the Inbox. The list may be out of date. <button onClick={refresh} className="font-medium underline">Try again</button>
      </div>}
      <div className="flex min-h-0 flex-1">
        <div aria-label="Inbox items" className={`${selected ? 'hidden md:block' : ''} w-full overflow-y-auto md:w-[360px] md:shrink-0 md:border-r md:border-zinc-200 md:dark:border-zinc-800 lg:w-[400px]`}>
          {loading ? <p role="status" className="p-6 text-sm text-zinc-500">Loading Inbox…</p> : filtered.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Inbox size={28} className="mx-auto mb-3 text-zinc-400" />
              <p className="text-sm font-medium">{error ? 'Inbox unavailable' : profile || project ? 'No items match these filters' : 'You’re all caught up'}</p>
              <p className="mt-2 text-sm text-zinc-500">{error ? 'Try refreshing to see what needs your attention.' : 'Questions, results to review, and tasks needing help appear here.'}</p>
              {(profile || project) && <button onClick={() => { setProfile(''); setProject(''); }} className="mt-4 text-sm underline">Clear filters</button>}
            </div>
          ) : categories.map(({ id, label, icon: Icon }) => {
            const group = filtered.filter(item => item.category === id);
            return group.length > 0 && <section key={id} aria-label={label} className="py-2">
              <h2 className="flex items-center gap-2 px-5 py-3 text-xs font-medium text-zinc-500"><Icon size={14} />{label}<span className="ml-auto tabular-nums">{group.length}</span></h2>
              {group.map(item => <button key={item.taskId} type="button" aria-pressed={selectedId === item.taskId} onClick={() => setSelectedId(item.taskId)}
                className={`block w-full border-l-2 px-5 py-4 text-left transition-colors ${selectedId === item.taskId ? 'border-violet-500 bg-violet-50/70 dark:bg-violet-950/30' : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}>
                <span className="block text-sm font-medium leading-snug">{item.title}</span>
                <span className="mt-1.5 block truncate text-xs text-zinc-500">{item.profileName}{item.projectName ? ` · ${item.projectName}` : ''}</span>
                <span className="mt-2 block line-clamp-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{item.summary}</span>
              </button>)}
            </section>;
          })}
        </div>
        <div className={`${selected ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col overflow-y-auto`}>
          {selected ? <InboxDetail key={selected.key} item={selected} stale={error} onBack={() => setSelectedId(null)} refresh={refresh} /> :
            <div className="m-auto p-8 text-center text-sm text-zinc-400"><Inbox size={30} className="mx-auto mb-3" />Select an item to see what needs your attention.</div>}
        </div>
      </div>
    </div>
  );
}

function InboxDetail({ item, stale, onBack, refresh }: { item: InboxItem; stale: boolean; onBack: () => void; refresh: () => void }) {
  const [preview, setPreview] = useState<InboxPreview | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchInboxPreview(item.taskId, item.key, controller.signal).then(result => {
      if (!controller.signal.aborted) setPreview(result);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [item.taskId, item.key]);
  return <article className="mx-auto w-full max-w-3xl p-5 sm:p-8">
    <button onClick={onBack} className="mb-6 flex items-center gap-2 text-sm text-zinc-500 md:hidden"><ArrowLeft size={16} />Back to Inbox</button>
    <p className="mb-3 text-xs font-medium text-zinc-500">{categories.find(category => category.id === item.category)?.label} · {item.profileName}{item.projectName ? ` · ${item.projectName}` : ''}</p>
    <h2 className="text-xl font-semibold tracking-tight">{item.title}</h2>
    <p className="mt-3 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{item.summary}</p>
    {!error && !stale && <Link to={inboxTaskUrl(item)} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">{item.actionLabel}<ArrowUpRight size={15} /></Link>}
    {error || stale ? <div role="status" className="mt-6 text-sm text-zinc-500">This preview is unavailable or may have changed. <button className="underline" onClick={() => { onBack(); refresh(); }}>Refresh Inbox</button></div> : !preview ?
      <p role="status" className="mt-6 text-sm text-zinc-500">Loading preview…</p> : <>
        <div className="mt-7 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          {preview.interaction ? <div className="space-y-5 text-sm">
            {preview.interaction.reason && <p className="whitespace-pre-wrap break-words">{preview.interaction.reason}</p>}
            {preview.interaction.command && <pre className="overflow-x-auto rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">{preview.interaction.command}</pre>}
            {preview.interaction.questions.map(question => <div key={question.id}>
              <p className="whitespace-pre-wrap break-words font-medium">{question.question}</p>
              {question.choices.length > 0 && <ul className="mt-3 list-disc space-y-2 pl-5 text-zinc-500">{question.choices.map((choice, index) => <li key={index}>{choice}</li>)}</ul>}
            </div>)}
            <p className="text-xs text-zinc-500">Open the task to respond.</p>
          </div> : <>
            <h3 className="mb-4 text-xs font-medium text-zinc-500">Latest saved reply{preview.reply ? ` · ${new Date(preview.reply.created_at).toLocaleString()}` : ''}</h3>
            {preview.reply ? <MarkdownContent content={preview.reply.content} taskId={item.taskId} profileId={item.profileId} /> :
              <p className="text-sm text-zinc-500">{preview.historyUnavailable ? 'The saved reply could not be loaded. Open the task to view its history.' : 'No saved reply yet. Open the task for details.'}</p>}
          </>}
        </div>
      </>}
  </article>;
}
