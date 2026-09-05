import { useCallback, useEffect, useRef, useState } from 'react';
import { validateInteractionResponse, type InteractionResponse, type TaskInteraction } from '@shared/interactions';
import { fetchTaskInteractions, respondTaskInteraction } from '../lib/api';
import { toErrorMessage } from '../lib/format';

const primary = 'min-h-9 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900';
const field = 'min-h-9 min-w-0 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';

export function TaskQuestionForm({ item, busy, onSubmit }: {
  item: TaskInteraction; busy: boolean; onSubmit: (response: InteractionResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [useOther, setUseOther] = useState<Record<string, boolean>>({});
  const answers: Record<string, string | string[]> = {};
  let emptyOther = false;
  for (const q of item.questions) {
    if (useOther[q.id] && !other[q.id]?.trim()) emptyOther = true;
    if (q.multiSelect) {
      const chosen = Array.isArray(values[q.id]) ? values[q.id] as string[] : [];
      answers[q.id] = useOther[q.id] ? [...chosen, other[q.id] ?? ''] : chosen;
    } else {
      answers[q.id] = useOther[q.id] ? other[q.id] ?? '' : values[q.id] as string ?? '';
    }
  }
  const validation = validateInteractionResponse(item, { answers });
  const ready = validation.ok && !emptyOther;
  const choose = (qid: string, value: string, multiple: boolean, checked: boolean) => {
    if (!multiple) setUseOther((previous) => ({ ...previous, [qid]: false }));
    setValues((previous) => {
      const selected = Array.isArray(previous[qid]) ? previous[qid] as string[] : [];
      return { ...previous, [qid]: multiple ? checked ? [...new Set([...selected, value])] : selected.filter((v) => v !== value) : value };
    });
  };
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) onSubmit(validation.response); }}>
      {item.questions.map((q) => (
        <fieldset key={q.id} disabled={busy} className="min-w-0 space-y-1">
          <legend id={`${item.id}-${q.id}`} className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">{q.question}</legend>
          {q.choices.length ? <>
            {q.choices.map((choice) => (
              <label key={choice} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}-${q.id}`}
                  checked={q.multiSelect ? Array.isArray(values[q.id]) && (values[q.id] as string[]).includes(choice) : !useOther[q.id] && values[q.id] === choice}
                  onChange={(event) => choose(q.id, choice, q.multiSelect, event.target.checked)} />
                <span className="min-w-0 break-words">{choice}</span>
              </label>
            ))}
            <div className="flex min-w-0 items-center gap-2">
              <label className="flex min-h-9 cursor-pointer items-center gap-2 px-1 text-zinc-600 dark:text-zinc-300">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}-${q.id}`} checked={!!useOther[q.id]}
                  onChange={(event) => setUseOther((previous) => ({ ...previous, [q.id]: event.target.checked }))} />Other
              </label>
              <input type="text" aria-label={`Other answer: ${q.question}`} maxLength={10000} value={other[q.id] ?? ''}
                onFocus={() => setUseOther((previous) => ({ ...previous, [q.id]: true }))}
                onChange={(event) => setOther((previous) => ({ ...previous, [q.id]: event.target.value }))}
                className={`${field} flex-1`} />
            </div>
          </> : (
            <textarea aria-labelledby={`${item.id}-${q.id}`} rows={2} maxLength={10000}
              value={Array.isArray(values[q.id]) ? (values[q.id] as string[])[0] ?? '' : values[q.id] ?? ''}
              onChange={(event) => setValues((previous) => ({ ...previous, [q.id]: q.multiSelect ? [event.target.value] : event.target.value }))}
              className={`${field} w-full`} />
          )}
        </fieldset>
      ))}
      <button type="submit" disabled={!ready || busy} className={primary}>Submit answers</button>
    </form>
  );
}

export function TaskInteractionPanel({ taskId, isStreaming, className = '' }: { taskId: string; isStreaming: boolean; className?: string }) {
  const [interactions, setInteractions] = useState<TaskInteraction[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await fetchTaskInteractions(taskId);
      if (request === generation.current) setInteractions(result.interactions);
    } catch (err) {
      if (request === generation.current) setError(toErrorMessage(err, 'Could not load questions'));
    }
  }, [taskId]);
  useEffect(() => {
    void refresh();
    const timer = isStreaming ? window.setInterval(() => void refresh(), 1500) : undefined;
    return () => { generation.current++; window.clearInterval(timer); };
  }, [isStreaming, refresh]);
  const item = interactions.find((i) => i.status === 'waiting' || i.status === 'claimed') ?? interactions[0];
  if (!item && !error) return null;
  const submit = async (response: InteractionResponse) => {
    if (!item || busyRef.current || item.status !== 'waiting') return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await respondTaskInteraction(taskId, item, response); }
    catch (err) { setError(toErrorMessage(err, 'Could not send response')); }
    finally { await refresh(); busyRef.current = false; setBusy(false); }
  };
  const statusLabels = {
    waiting: 'Hermes is waiting for you.', claimed: 'Delivering your response…', answered: 'Response saved.',
    denied: 'Action denied.', expired: 'Request expired. Send a new message to continue.',
    cancelled: 'This request was closed when the run stopped.', delivery_unknown: 'Delivery outcome is unknown. Do not resubmit; stop or check the run first.',
  };
  const response = item?.response;
  const summary = !response ? null : 'decision' in response ? response.decision === 'once' ? 'Approved once' : 'Denied' : Object.values(response.answers).map((value) => Array.isArray(value) ? value.join(', ') : value).join(' · ');
  return (
    <section aria-label="Task questions and approvals" className={`${className} mb-2 max-h-[55vh] overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900/70`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 break-words">
          <div className="font-semibold text-zinc-800 dark:text-zinc-100">{item?.title ?? 'Task questions'}</div>
          <p role="status" className="text-xs text-zinc-500 dark:text-zinc-400">{item ? statusLabels[item.status] : 'Questions could not be loaded.'}</p>
        </div>
        <button type="button" onClick={() => { setError(null); void refresh(); }} className="min-h-9 shrink-0 rounded-md px-2 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">Refresh</button>
      </div>
      {item?.kind === 'clarification' && item.status === 'waiting' && <TaskQuestionForm key={item.id} item={item} busy={busy} onSubmit={(response) => void submit(response)} />}
      {item?.kind === 'approval' && item.status === 'waiting' && <div className="space-y-2">
        {item.reason && <p className="break-words text-zinc-600 dark:text-zinc-300">{item.reason}</p>}
        {item.command && <pre className="max-h-28 overflow-auto rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{item.command}</pre>}
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void submit({ decision: 'once' })} className={primary}>Approve once</button>
          <button type="button" disabled={busy} onClick={() => void submit({ decision: 'deny' })} className="min-h-9 rounded-lg border border-zinc-300 px-3 py-2 text-xs dark:border-zinc-600">Deny</button>
        </div>
      </div>}
      {summary && <p className="mt-2 break-words text-xs text-zinc-500 dark:text-zinc-400">Submitted: {summary}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
