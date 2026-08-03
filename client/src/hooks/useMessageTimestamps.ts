import { useCallback, useState } from 'react';
import { getShowMessageTimestamps, setShowMessageTimestamps } from '../lib/messageTimestamps';

export function useMessageTimestamps() {
  const [enabled, setEnabledState] = useState(getShowMessageTimestamps);

  const setEnabled = useCallback((next: boolean) => {
    setShowMessageTimestamps(next);
    setEnabledState(next);
  }, []);

  return { enabled, setEnabled } as const;
}
