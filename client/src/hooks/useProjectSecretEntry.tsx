import { useEffect, useRef, useState } from 'react';
import { SecretEntryDialog, type SecretEntryDraft } from '../components/SecretEntryDialog';

export function useProjectSecretEntry({ projectId, taskId, profileId }: { projectId?: string | null; taskId?: string; profileId?: string }) {
  const scope = `${profileId ?? ''}:${taskId ?? 'new'}:${projectId ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [draft, setDraft] = useState<{ scope: string; value: SecretEntryDraft } | null>(null);
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);
  useEffect(() => { setDraft(null); setNotice(null); }, [scope]);
  return {
    open: () => { setNotice(null); setDraft({ scope, value: {} }); },
    notice: notice?.scope === scope ? <p role="status" className="px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice.text}</p> : null,
    dialog: draft?.scope === scope ? <SecretEntryDialog key={scope} draft={draft.value} projectId={projectId} taskId={taskId} onClose={() => setDraft(null)} onSaved={(names, _id, name) => {
      if (scopeRef.current !== scope) return;
      setDraft(null);
      setNotice({ scope, text: `Saved ${names.join(', ')} in ${name} → Project Settings → Secrets.` });
    }} /> : null,
  };
}
