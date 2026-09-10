import type { CodingCheck } from './coding-evidence.js';

/** Keep the failing assertion visible even when package-manager notices end the log. */
export function codingFailureDetails(check: Pick<CodingCheck, 'output' | 'timedOut' | 'exitCode'>) {
  const output = check.output.replace(/\u001b\[[0-9;]*m/g, '');
  const counts = output.match(/^\s*Tests\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?/m);
  const summary = check.timedOut ? 'Check timed out' : counts
    ? `${counts[1]} ${counts[1] === '1' ? 'test' : 'tests'} failed${counts[2] ? ` · ${counts[2]} passed` : ''}`
    : `Check failed${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}`;
  const lines = output.split('\n').filter(line => !/^npm notice(?:\s|$)/.test(line));
  const failedTest = lines.findIndex(line => /^\s*FAIL(?:ED)?(?:\s|:)/.test(line));
  const firstFailure = failedTest >= 0 ? failedTest : lines.findIndex(line => /^\s*(?:\w*Error|error)(?:\s+TS\d+)?:/.test(line));
  const excerpt = (firstFailure >= 0 ? lines.slice(firstFailure).join('\n').slice(0, 6000) : lines.join('\n').slice(-6000)).trim();
  return { summary, excerpt: excerpt || 'The command returned no output.' };
}
