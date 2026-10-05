// Real React and browser timers; isolated HTTP fixture, no live tasks or agent.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TaskInteractionPanel } from '../../client/src/components/TaskInteractionPanel';
import type { TaskInteraction } from '../../shared/interactions';
import '../../client/src/styles/globals.css';

let item: TaskInteraction = {
  id: 'confirmation', taskId: 'fixture', profileName: 'default', olympusRunId: 'run', workerRunId: 'worker',
  kind: 'approval', title: 'Verify confirmation cleanup', questions: [], expiresAt: 0,
  status: 'waiting', requestedAt: Date.now(), settledAt: null, response: null,
};
window.fetch = async (input, init) => {
  if (!String(input).includes('/interactions')) throw new Error(`Unexpected fixture request: ${String(input)}`);
  if (init?.method === 'POST') {
    item = { ...item, status: 'answered', response: { decision: 'once' }, settledAt: Date.now() };
    return Response.json({ interaction: item });
  }
  return Response.json({ interactions: [item] });
};

const root = document.getElementById('root')!;
createRoot(root).render(<main className="mx-auto max-w-4xl p-6">
  <h1 className="mb-6 text-lg font-semibold">Answer confirmation timeout</h1>
  <p className="mb-4">Approve this test request, then leave the page untouched for one minute.</p>
  <TaskInteractionPanel taskId="fixture" isStreaming={false} />
  <textarea aria-label="Chat draft" className="w-full rounded-xl border p-4" defaultValue="This unsent draft should remain unchanged." />
  <p id="test-result" role="status" className="mt-5" />
</main>);

let sawConfirmation = false;
const observer = new MutationObserver(() => {
  const panel = root.querySelector('[aria-label="Task questions and approvals"]');
  if (panel?.textContent?.includes('Answer submitted')) sawConfirmation = true;
  if (!sawConfirmation || panel || item.settledAt === null) return;
  observer.disconnect();
  const elapsedMs = Date.now() - item.settledAt;
  const draft = root.querySelector('textarea')?.value;
  root.dataset.elapsedMs = String(elapsedMs);
  root.dataset.result = elapsedMs >= 59_990 && draft === 'This unsent draft should remain unchanged.' ? 'passed' : 'failed';
  root.querySelector('#test-result')!.textContent = `${root.dataset.result === 'passed' ? 'PASS' : 'FAIL'}: Confirmation dismissed automatically after ${(elapsedMs / 1000).toFixed(1)} seconds. No reload; draft preserved.`;
});
observer.observe(root, { childList: true, subtree: true });
