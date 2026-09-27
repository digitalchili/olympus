import { useCallback, useEffect, useRef, useState } from 'react';
import { parseProjectSecretInput } from '@shared/project-secrets';
import { SecretEntryDialog, type SecretEntryDraft } from '../components/SecretEntryDialog';

export function useProjectSecretEntry({ projectId, taskId, profileId, disabled = false }: { projectId?: string | null; taskId?: string; profileId?: string; disabled?: boolean }) {
  const scope = `${profileId ?? ''}:${taskId ?? 'new'}:${projectId ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [draft, setDraft] = useState<{ scope: string; value: SecretEntryDraft } | null>(null);
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);
  useEffect(() => { setDraft(null); setNotice(null); }, [scope]);
  const intercept = useCallback((text: string) => {
    const parsed = parseProjectSecretInput(text);
    if (parsed.kind === 'none') return false;
    if (disabled) {
      setNotice({ scope, text: 'Save secrets from a Project task or Project Settings. This message was not sent.' });
      return true;
    }
    setNotice(null);
    setDraft({ scope, value: parsed.kind === 'secrets' ? { entries: parsed.entries } : { error: parsed.error } });
    return true;
  }, [disabled, scope]);
  return {
    intercept,
    open: () => { setNotice(null); setDraft({ scope, value: {} }); },
    notice: notice?.scope === scope ? <p role="status" className="px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice.text}</p> : null,
    dialog: draft?.scope === scope ? <SecretEntryDialog key={scope} draft={draft.value} projectId={projectId} taskId={taskId} onClose={() => setDraft(null)} onSaved={(names, _id, name) => {
      if (scopeRef.current !== scope) return;
      setDraft(null);
      setNotice({ scope, text: `Saved ${names.join(', ')} in ${name} → Project Settings → Secrets.` });
    }} /> : null,
  };
}
