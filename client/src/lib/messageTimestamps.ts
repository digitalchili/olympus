type MessageTimestamp = {
  created_at: number;
  completed_at?: number;
};

const STORAGE_KEY = 'show-message-timestamps';

export function getShowMessageTimestamps(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  return storage.getItem(STORAGE_KEY) !== 'false';
}

export function setShowMessageTimestamps(
  enabled: boolean,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, String(enabled));
}

export function selectMessageTimestamp(message: MessageTimestamp): number | null {
  const timestamp = message.completed_at || message.created_at;
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function formatMessageTimestamp(
  timestamp: number,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locales, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(timestamp);
}

export function messageTimestampTitle(
  message: MessageTimestamp,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string | undefined {
  const timestamp = selectMessageTimestamp(message);
  return timestamp === null ? undefined : formatMessageTimestamp(timestamp, locales, timeZone);
}

export function formatFullMessageTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(timestamp);
}
