import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageAttachmentCards } from '../client/src/components/ChatAttachments.js';

const pdfPath = '~/.olympus-dispatch/workspace/uploads/generated/report.pdf';
const markup = renderToStaticMarkup(createElement(MessageAttachmentCards, {
  paths: [pdfPath],
}));

assert.match(markup, /report\.pdf/);
assert.match(markup, /Download report\.pdf/);
assert.match(markup, /\/api\/files\/download\?path=/);
assert.match(markup, / PDF<\/span>/);

const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
assert.match(taskChatSource, /const \{ text: assistantText, filePaths: assistantFilePaths \} = splitAttachmentMessage\(msg\.content\);/);
assert.match(taskChatSource, /<MarkdownContent content=\{assistantText\}/);
assert.match(taskChatSource, /<MessageAttachmentCards paths=\{assistantFilePaths\} \/>/);
assert.match(taskChatSource, /shouldShowReplyCopyButton\(assistantText, isLastAssistant && isStreaming\)/);
assert.match(taskChatSource, /<ReplyCopyButton content=\{assistantText\} \/>/);

console.log('Assistant attachment card tests passed');
