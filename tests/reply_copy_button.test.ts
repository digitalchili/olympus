import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplyCopyButton, shouldShowReplyCopyButton } from '../client/src/components/ReplyCopyButton.js';

const markup = renderToStaticMarkup(createElement(ReplyCopyButton, {
  content: 'Reply with **Markdown** and `code`.',
}));

assert.match(markup, /type="button"/);
assert.match(markup, /aria-label="Copy reply"/);
assert.match(markup, /title="Copy reply"/);
assert.match(markup, /data-reply-copy-button="true"/);

assert.equal(shouldShowReplyCopyButton('Complete reply', false), true);
assert.equal(shouldShowReplyCopyButton('Streaming reply', true), false);
assert.equal(shouldShowReplyCopyButton('', false), false);

const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
assert.match(taskChatSource, /import \{ ReplyCopyButton, shouldShowReplyCopyButton \} from ['"]\.\/ReplyCopyButton['"]/);
assert.match(taskChatSource, /shouldShowReplyCopyButton\(msg\.content, isLastAssistant && isStreaming\)/);
assert.match(taskChatSource, /<ReplyCopyButton content=\{msg\.content\} \/>/);

console.log('Reply copy button tests passed');
