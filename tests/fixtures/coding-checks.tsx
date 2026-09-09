// Browser regression: real panel, simulated verification HTTP; no live tasks.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CodingEvidencePanel } from '../../client/src/components/CodingEvidencePanel';
import type { CodingEvidence } from '../../shared/coding-evidence';
import '../../client/src/styles/globals.css';

const source = { head: 'fb1e0f6fb096', fingerprint: 'fixture', changedFiles: ['M example.ts'], diff: '' };
let evidence: CodingEvidence = { taskId: 'fixture', runId: 'run-1', workdir: '/fixture',
  status: 'failed', baseline: source, source, reason: 'A required verification command failed',
  checks: [{ command: ['npm', 'test'], exitCode: 1, output: 'Passed unrelated test\n'.repeat(400) + '\u001b[31mFAIL example.test.ts\u001b[39m\nExpected 03:06, received 10:06', durationMs: 4000, timedOut: false }],
  updatedAt: 1700000000000 };
let settle: (() => void) | undefined;
let rejectRequest = false;
window.fetch = async (_input, init) => {
  if (init?.method === 'POST') {
    if (rejectRequest) return new Response(JSON.stringify({ error: 'Wait for the active run to settle.' }), { status: 409 });
    await new Promise<void>(resolve => { settle = resolve; });
    evidence = { ...evidence, updatedAt: Date.now() };
  }
  return new Response(JSON.stringify({ evidence }), { headers: { 'Content-Type': 'application/json' } });
};
const root = document.getElementById('root')!;
createRoot(root).render(<main className="mx-auto max-w-4xl p-6"><h1 className="mb-6 text-lg">Verification result fixture</h1><CodingEvidencePanel taskId="fixture" isStreaming={false} /><p id="test-result" className="mt-5" /></main>);

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
  await waitFor(() => !!button() && !button().disabled);
  check(root.innerText.includes('Finished'), 'Rerun must show a completion time');
  const output = Array.from(root.querySelectorAll('pre')).find(node => node.textContent?.includes('Expected 03:06'));
  check(output?.checkVisibility(), 'Failed output must be visible without opening a disclosure');
  check(output && output.scrollHeight - output.clientHeight - output.scrollTop < 2, 'Failure excerpt must start at the final result, not earlier passing logs');
  check(!output?.textContent?.includes('\u001b'), 'Failure output must not show terminal color escapes');
  check(root.innerText.includes('Full command output'), 'Long output must remain available beyond the failure excerpt');
  rejectRequest = true;
  button().click();
  await waitFor(() => !!root.querySelector('[role="alert"]'));
  check(root.querySelector('[role="alert"]')?.textContent?.includes('Wait for the active run'), 'Rejected rerun must show its error');
  check(!button().disabled, 'Rejected rerun must release the button');
  root.querySelector('#test-result')!.textContent = 'PASS: rerun progress, completion time, visible failure, and request error';
})().catch(error => { root.querySelector('#test-result')!.textContent = `FAIL: ${error.message}`; });
