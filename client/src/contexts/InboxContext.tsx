import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { InboxItem } from '@shared/inbox';
import { fetchInbox } from '../lib/api';

interface InboxState {
  items: InboxItem[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
}
const InboxContext = createContext<InboxState | null>(null);

export function InboxProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await fetchInbox(controller.signal);
        if (!controller.signal.aborted) { setItems(result.items); setError(false); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort(); window.clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [revision]);
  return <InboxContext.Provider value={{ items, loading, error, refresh }}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxState {
  const value = useContext(InboxContext);
  if (!value) throw new Error('useInbox must be used within InboxProvider');
  return value;
}
