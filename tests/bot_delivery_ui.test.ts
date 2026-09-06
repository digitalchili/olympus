import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotMessage } from '../shared/types.js';
import { BotDeliveryActivity } from '../client/src/components/BotDeliveryActivity.js';

for (const status of ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'] as const) {
  const message = {
    id: status, senderProfileId: 'writer', recipientProfileId: 'reviewer', senderLabel: 'Writer', recipientLabel: 'Reviewer',
    message: '<script>unsafe()</script>', kind: 'request', status, error: null, createdAt: 1, updatedAt: 2,
  } as BotMessage;
  const html = renderToStaticMarkup(createElement(BotDeliveryActivity, { messages: [message], pendingId: null, onAction() {} }));
  assert.match(html, /Writer/); assert.match(html, /Reviewer/);
  assert.ok(!html.includes('<script>'), 'delivery text is rendered as text');
  assert.equal(html.includes('Retry delivery'), ['failed', 'interrupted'].includes(status));
  assert.equal(html.includes('Cancel delivery'), ['queued', 'running'].includes(status));
  if (status === 'interrupted') assert.match(html, /Check the recipient/);
}
console.log('Bot delivery action and attribution UI passed');
