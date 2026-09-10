// Browser regression: real panel, simulated verification HTTP; no live tasks.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CodingEvidencePanel } from '../../client/src/components/CodingEvidencePanel';
import { TaskInteractionPanel } from '../../client/src/components/TaskInteractionPanel';
import type { CodingEvidence } from '../../shared/coding-evidence';
import type { TaskRecoveryStatus } from '../../client/src/lib/api';
import '../../client/src/styles/globals.css';

const source = { head: 'fb1e0f6fb096', fingerprint: 'fixture', changedFiles: ['M example.ts'], diff: '' };
let evidence: CodingEvidence = { taskId: 'fixture', runId: 'run-1', workdir: '/fixture',
  status: 'failed', baseline: source, source, reason: 'A required verification command failed',
  checks: [{ command: ['npm', 'test'], exitCode: 1, output: 'Passed unrelated test\n'.repeat(400) + '\u001b[31mFAIL example.test.ts\u001b[39m\nExpected 03:06, received 10:06\n Tests 1 failed | 569 passed (570)\n' + 'npm notice New version available\n'.repeat(100), durationMs: 4000, timedOut: false }],
  updatedAt: 1700000000000 };
let settle: (() => void) | undefined;
let rejectRequest = false;
const automaticRepair = new URLSearchParams(location.search).has('repair');
let recovery: TaskRecoveryStatus | null = null;
window.fetch = async (input, init) => {
  if (String(input).includes('/interactions')) return new Response(JSON.stringify({ interactions: [{ id: 'answered', kind: 'clarification', title: 'Your decision is needed', status: 'answered', questions: [], response: { answers: { scope: 'Authorize timezone fixes' } } }] }));
  if (String(input).includes('/recovery/stop')) {
    recovery = { ...recovery!, state: 'blocked', reason: 'Stopped by user' };
    return new Response(JSON.stringify({ paused: true }));
  }
  if (String(input).includes('/recovery')) return new Response(JSON.stringify({ recovery }));
  if (init?.method === 'POST') {
    if (rejectRequest) return new Response(JSON.stringify({ error: 'Wait for the active run to settle.' }), { status: 409 });
    await new Promise<void>(resolve => { settle = resolve; });
    evidence = { ...evidence, updatedAt: Date.now() };
    if (automaticRepair) recovery = { kind: 'verification', state: 'pending', reason: 'verification_failed', attempts: 0, deadlineAt: 0, checkpoint: null };
  }
  return new Response(JSON.stringify({ evidence }), { headers: { 'Content-Type': 'application/json' } });
};
const root = document.getElementById('root')!;
createRoot(root).render(<main className="mx-auto max-w-4xl p-6"><h1 className="mb-6 text-lg">Verification result fixture</h1><CodingEvidencePanel taskId="fixture" isStreaming={false} onViewAgentReply={() => { root.dataset.replyRequested = 'true'; }} /><TaskInteractionPanel taskId="fixture" isStreaming={false} /><p id="test-result" className="mt-5" /></main>);

const waitFor = async (predicate: () => boolean) => {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out waiting for panel state'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const button = () => Array.from(root.querySelectorAll('button')).find(node => /Run checks|Run checks again/.test(node.textContent ?? ''))!;
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
void (async () => {
  await waitFor(() => !!button());
  button().click();
  await waitFor(() => !!settle);
  check(root.querySelector('summary [role="status"]')?.textContent?.includes('Running'), 'Rerun must immediately replace the old failed heading');
  check(!root.innerText.includes('A required verification command failed'), 'Previous failure must not appear as the current running result');
  root.querySelector('summary')!.click(); // The result must reopen even if progress was collapsed.
  settle!();
  if (automaticRepair) {
    await waitFor(() => root.innerText.includes('repair these failures'));
    check(button().disabled, 'Queued automatic repair must not offer a duplicate rerun');
    const pause = Array.from(root.querySelectorAll('button')).find(node => node.textContent === 'Pause automatic repair');
    check(pause, 'Queued repair must have a Pause control');
    pause!.click();
    await waitFor(() => root.innerText.includes('Stopped by user'));
  }
  await waitFor(() => !!button() && !button().disabled);
  check(root.innerText.includes('Finished'), 'Rerun must show a completion time');
  const output = Array.from(root.querySelectorAll('pre')).find(node => node.textContent?.includes('Expected 03:06'));
  check(output?.checkVisibility(), 'Failed output must be visible without opening a disclosure');
  check(output?.scrollTop === 0, 'Failure excerpt must start at the actual error');
  check(!output?.textContent?.includes('npm notice'), 'Failure excerpt must omit trailing package-manager notices');
  check(root.innerText.includes('1 test failed · 569 passed'), 'Failure count must explain the result');
  check(root.innerText.includes('Answer submitted') && !root.innerText.includes('Your decision is needed'), 'Answered questions must not still request a decision');
  check(!output?.textContent?.includes('\u001b'), 'Failure output must not show terminal color escapes');
  check(root.innerText.includes('Full command output'), 'Long output must remain available beyond the failure excerpt');
  Array.from(root.querySelectorAll('button')).find(node => node.textContent === 'Read the agent’s explanation')!.click();
  check(root.dataset.replyRequested === 'true', 'Failed checks must link to the agent explanation');
  rejectRequest = true;
  button().click();
  await waitFor(() => !!root.querySelector('[role="alert"]'));
  check(root.querySelector('[role="alert"]')?.textContent?.includes('Wait for the active run'), 'Rejected rerun must show its error');
  check(!button().disabled, 'Rejected rerun must release the button');
  root.querySelector('#test-result')!.textContent = `PASS: rerun progress, completion time, visible failure, and request error${automaticRepair ? ', automatic repair queue and Pause' : ''}`;
})().catch(error => { root.querySelector('#test-result')!.textContent = `FAIL: ${error.message}`; });
