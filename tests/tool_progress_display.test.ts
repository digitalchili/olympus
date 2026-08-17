import assert from 'node:assert/strict';
import { visibleToolProgress } from '../client/src/lib/toolProgressDisplay.js';

const tools = [
  { tool: 'skill_view', status: 'completed' as const, duration: 0.1 },
  { tool: 'browser_navigate', status: 'error' as const, duration: 0.3 },
  { tool: 'terminal', status: 'running' as const },
];

assert.deepEqual(visibleToolProgress(tools), [tools[2]], 'only the latest progress card is visible');
assert.deepEqual(visibleToolProgress([]), []);
