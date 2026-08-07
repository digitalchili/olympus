import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplyCopyButton, shouldShowReplyCopyButton } from '../client/src/components/ReplyCopyButton.js';

const replyMarkup = renderToStaticMarkup(createElement(ReplyCopyButton, {
  content: 'Reply with **Markdown** and `code`.',
}));
const questionMarkup = renderToStaticMarkup(createElement(ReplyCopyButton, {
  content: 'What does this mean?',
  kind: 'question',
}));

assert.match(replyMarkup, /type="button"/);
assert.match(replyMarkup, /aria-label="Copy reply"/);
assert.match(replyMarkup, /title="Copy reply"/);
assert.match(replyMarkup, /data-reply-copy-button="true"/);
assert.match(questionMarkup, /aria-label="Copy question"/);
assert.match(questionMarkup, /title="Copy question"/);
assert.match(questionMarkup, /data-question-copy-button="true"/);

assert.equal(shouldShowReplyCopyButton('Complete reply', false), true);
assert.equal(shouldShowReplyCopyButton('Streaming reply', true), false);
assert.equal(shouldShowReplyCopyButton('', false), false);

const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
assert.match(taskChatSource, /import \{ ReplyCopyButton, shouldShowReplyCopyButton \} from ['"]\.\/ReplyCopyButton['"]/);
assert.match(taskChatSource, /shouldShowReplyCopyButton\(assistantText, isLastAssistant && isStreaming\)/);
assert.match(taskChatSource, /<ReplyCopyButton content=\{assistantText\} \/>/);

console.log('Reply copy button tests passed');
