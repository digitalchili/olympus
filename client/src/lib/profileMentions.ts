export interface ProfileMentionOption {
  id: string;
  label: string;
}

export interface ActiveProfileMention {
  start: number;
  end: number;
  query: string;
  options: ProfileMentionOption[];
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

export function findActiveProfileMention(
  text: string,
  cursor: number,
  profiles: ProfileMentionOption[],
): ActiveProfileMention | null {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|\s)@([a-zA-Z]*)$/.exec(beforeCursor);
  if (!match || match.index === undefined) return null;
  const atOffset = beforeCursor.lastIndexOf('@');
  if (!isBoundary(text[atOffset - 1])) return null;
  const query = match[1].toLowerCase();
  const options = profiles.filter((profile) => (
    profile.label.toLowerCase().includes(query) || profile.id.toLowerCase().includes(query)
  ));
  return { start: atOffset, end: cursor, query, options };
}

export function applyProfileMentionSelection(
  text: string,
  range: Pick<ActiveProfileMention, 'start' | 'end'>,
  profile: ProfileMentionOption,
): { text: string; profile: ProfileMentionOption; cursor: number } {
  const prefix = text.slice(0, range.start).replace(/[ \t]+$/, '');
  const suffix = text.slice(range.end).replace(/^[ \t]+/, '');
  const nextText = [prefix, suffix].filter(Boolean).join(' ');
  const cursor = prefix && suffix ? prefix.length + 1 : prefix.length;
  return { text: nextText, profile, cursor };
}
