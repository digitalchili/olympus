type ClipboardWriter = Pick<Clipboard, 'writeText'>;

function copyWithDocument(text: string, documentRef: Document): void {
  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  documentRef.body.appendChild(textarea);
  textarea.select();

  try {
    if (!documentRef.execCommand('copy')) {
      throw new Error('Unable to copy text to the clipboard');
    }
  } finally {
    documentRef.body.removeChild(textarea);
  }
}

export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardWriter | null = typeof navigator === 'undefined'
    ? null
    : navigator.clipboard ?? null,
  documentRef: Document | null = typeof document === 'undefined' ? null : document,
): Promise<void> {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Non-secure origins and denied browser permissions can reject here.
    }
  }

  if (!documentRef?.body || typeof documentRef.execCommand !== 'function') {
    throw new Error('Unable to copy text to the clipboard');
  }

  copyWithDocument(text, documentRef);
}

export function installClipboardFallback(
  navigatorRef: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  documentRef: Document | undefined = typeof document === 'undefined' ? undefined : document,
): boolean {
  if (!navigatorRef || !documentRef || navigatorRef.clipboard) return false;

  try {
    Object.defineProperty(navigatorRef, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => copyTextToClipboard(text, null, documentRef),
      },
    });
    return true;
  } catch {
    return false;
  }
}
