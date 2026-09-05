export const CLIPBOARD_ATTACHMENT_CHAR_THRESHOLD = 4_000;
export const CLIPBOARD_ATTACHMENT_LINE_THRESHOLD = 50;
export const CLIPBOARD_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export interface ClipboardTextAttachmentMetadata {
  text: string;
  preview: string;
  lineCount: number;
  size: number;
  snapshotValue?: string;
  selectionStart?: number;
  selectionEnd?: number;
}

export type ClipboardTextAttachmentResult =
  | { ok: true; file: File; metadata: ClipboardTextAttachmentMetadata }
  | { ok: false; error: string };

const PREVIEW_MAX_LENGTH = 160;

export function clipboardLineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function shouldAttachClipboardText(text: string): boolean {
  return text.length >= CLIPBOARD_ATTACHMENT_CHAR_THRESHOLD
    || clipboardLineCount(text) >= CLIPBOARD_ATTACHMENT_LINE_THRESHOLD;
}

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

export function clipboardTextFileName(_text: string): string {
  // The upload ID provides uniqueness. Content belongs in the document, not URLs.
  return 'clipboard-paste.txt';
}

export function createClipboardTextAttachment(text: string): ClipboardTextAttachmentResult {
  const size = utf8Size(text);
  if (size > CLIPBOARD_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: 'Pasted text is too large to attach. Keep it inline or shorten it before sending.' };
  }

  return {
    ok: true,
    file: new File([text], clipboardTextFileName(text), { type: 'text/plain;charset=utf-8' }),
    metadata: {
      text,
      preview: truncate(firstLine(text) || 'Pasted text', PREVIEW_MAX_LENGTH),
      lineCount: clipboardLineCount(text),
      size,
    },
  };
}

export function restoreClipboardAttachmentInline({
  currentValue,
  snapshotValue,
  selectionStart,
  selectionEnd,
  text,
}: {
  currentValue: string;
  snapshotValue: string;
  selectionStart: number;
  selectionEnd: number;
  text: string;
}): { value: string; cursor: number } {
  if (currentValue === snapshotValue) {
    const value = `${snapshotValue.slice(0, selectionStart)}${text}${snapshotValue.slice(selectionEnd)}`;
    return { value, cursor: selectionStart + text.length };
  }

  const separator = currentValue.length === 0 || currentValue.endsWith('\n') ? '' : '\n';
  const value = `${currentValue}${separator}${text}`;
  return { value, cursor: value.length };
}
