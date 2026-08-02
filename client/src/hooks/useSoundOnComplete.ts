import { useCallback, useState } from 'react';

const STORAGE_KEY = 'sound-on-complete';
const SOUND_URL = '/sounds/done.mp3';

const audio = new Audio(SOUND_URL);
audio.preload = 'auto';

function getStored(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

function play() {
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

export function playCompletionSound() {
  if (!getStored()) return;
  play();
}

export function useSoundOnComplete() {
  const [enabled, setEnabledState] = useState<boolean>(getStored);

  const setEnabled = useCallback((next: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(next));
    setEnabledState(next);
  }, []);

  return { enabled, setEnabled, playPreview: play } as const;
}
