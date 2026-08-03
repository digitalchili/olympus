import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { copyTextToClipboard, installClipboardFallback } from '../client/src/lib/clipboard.js';

function createFakeDocument(commandResult = true) {
  let appendedValue = '';
  let command = '';
  let removed = false;
  let selected = false;

  const textarea = {
    value: '',
    style: {},
    setAttribute() {},
    select() {
      selected = true;
    },
  };

  const documentRef = {
    body: {
      appendChild(node: typeof textarea) {
        appendedValue = node.value;
      },
      removeChild() {
        removed = true;
      },
    },
    createElement(tag: string) {
      assert.equal(tag, 'textarea');
      return textarea;
    },
    execCommand(nextCommand: string) {
      command = nextCommand;
      return commandResult;
    },
  } as unknown as Document;

  return {
    documentRef,
    state: () => ({ appendedValue, command, removed, selected }),
  };
}

{
  const { documentRef, state } = createFakeDocument();
  await copyTextToClipboard('fallback copy', null, documentRef);
  assert.deepEqual(state(), {
    appendedValue: 'fallback copy',
    command: 'copy',
    removed: true,
    selected: true,
  });
}

{
  let nativeValue = '';
  const { documentRef, state } = createFakeDocument();
  await copyTextToClipboard('native copy', {
    async writeText(value: string) {
      nativeValue = value;
    },
  }, documentRef);
  assert.equal(nativeValue, 'native copy');
  assert.equal(state().command, '');
}

{
  const { documentRef, state } = createFakeDocument();
  await copyTextToClipboard('recovered copy', {
    async writeText() {
      throw new Error('permission denied');
    },
  }, documentRef);
  assert.equal(state().appendedValue, 'recovered copy');
  assert.equal(state().command, 'copy');
}

{
  const { documentRef, state } = createFakeDocument();
  const navigatorRef = {} as Navigator;
  assert.equal(installClipboardFallback(navigatorRef, documentRef), true);
  await navigatorRef.clipboard.writeText('streamdown copy');
  assert.equal(state().appendedValue, 'streamdown copy');
  assert.equal(state().command, 'copy');
  assert.equal(installClipboardFallback(navigatorRef, documentRef), false);
}

{
  const { documentRef } = createFakeDocument(false);
  await assert.rejects(
    copyTextToClipboard('failed copy', null, documentRef),
    /Unable to copy text to the clipboard/,
  );
}

{
  const mainSource = await readFile('client/src/main.tsx', 'utf8');
  assert.match(mainSource, /import \{ installClipboardFallback \} from ['"]\.\/lib\/clipboard['"]/);
  assert.match(mainSource, /installClipboardFallback\(\)/);
}

console.log('Clipboard fallback tests passed');
