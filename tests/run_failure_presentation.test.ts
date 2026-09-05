import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveChatRun, TaskAgentRun } from '../shared/types.js';
import {
  canManuallySendQueuedMessage,
  deriveRunFailureNotice,
  queuedMessageWaitingLabel,
  runFailureNoticeForState,
  currentLiveRun,
  shouldAutoSendQueuedMessage,
} from '../client/src/lib/runFailurePresentation.js';
import { RunFailureBanner } from '../client/src/components/RunFailureBanner.js';

const failedPersistedRun = {
  runId: 'run-runtime',
  taskId: 'task-1',
  kind: 'chat',
  status: 'error',
  errorCode: 'run_runtime_timeout',
  modelResolution: null,
  startedAt: 100,
  updatedAt: 200,
  completedAt: 200,
} satisfies TaskAgentRun & { errorCode?: string | null };

const runtimeNotice = deriveRunFailureNotice(failedPersistedRun);
assert.ok(runtimeNotice, 'a latest persisted failed run needs a reload-safe notice');
assert.match(runtimeNotice.title, /run cap/i);
assert.match(runtimeNotice.detail, /unfinished/i);
assert.match(runtimeNotice.detail, /partial transcript/i);

const idleNotice = deriveRunFailureNotice({
  ...failedPersistedRun,
  runId: 'run-idle',
  errorCode: 'run_idle_timeout',
});
assert.ok(idleNotice);
assert.match(idleNotice.detail, /no activity/i, 'idle timeout wording is distinct from the runtime cap');
assert.doesNotMatch(idleNotice.detail, /run cap/i);

const iterationNotice = deriveRunFailureNotice({
  ...failedPersistedRun,
  runId: 'run-iteration',
  errorCode: 'iteration_limit',
});
assert.ok(iterationNotice);
assert.match(iterationNotice.detail, /tool-iteration/i, 'iteration-limit wording names the iteration cap');
assert.match(iterationNotice.detail, /unfinished/i);

const stoppedNotice = deriveRunFailureNotice({
  ...failedPersistedRun,
  runId: 'run-stopped',
  status: 'stopped',
  errorCode: null,
});
assert.ok(stoppedNotice);
assert.match(stoppedNotice.title, /stopped/i);
assert.match(stoppedNotice.detail, /unfinished/i);

const providerNotice = deriveRunFailureNotice({
  ...failedPersistedRun,
  runId: 'run-provider',
  errorCode: 'provider_error',
});
assert.ok(providerNotice);
assert.match(providerNotice.detail, /provider_error/);
assert.match(providerNotice.detail, /unfinished/i);

assert.equal(deriveRunFailureNotice({ ...failedPersistedRun, status: 'done' }), null);
assert.equal(deriveRunFailureNotice({ ...failedPersistedRun, status: 'streaming' }), null);

const streamingLiveRun = {
  taskId: 'task-1',
  runId: 'run-new',
  kind: 'chat',
  sessionId: 'task-1',
  status: 'streaming',
  startedAt: 300,
  updatedAt: 300,
  messages: [],
} satisfies LiveChatRun;
assert.equal(
  runFailureNoticeForState({ liveRun: streamingLiveRun, latestAgentRun: failedPersistedRun }),
  null,
  'a later streaming run clears the old failed-run blocker before SSE completion',
);
assert.equal(
  runFailureNoticeForState({ liveRun: { ...streamingLiveRun, status: 'done' }, latestAgentRun: failedPersistedRun }),
  null,
  'a later successful run clears the old failed-run blocker',
);
assert.deepEqual(
  runFailureNoticeForState({ liveRun: null, latestAgentRun: failedPersistedRun }),
  runtimeNotice,
  'reload derives the notice from latestAgentRun when no live snapshot exists',
);

const liveErrorRun = {
  ...streamingLiveRun,
  runId: 'run-live-error',
  status: 'error',
  error: 'Hermes run produced no activity for 300000ms and was stopped',
  errorCode: 'run_idle_timeout',
} satisfies LiveChatRun & { errorCode?: string | null };
assert.match(
  runFailureNoticeForState({ liveRun: liveErrorRun, latestAgentRun: null })?.detail ?? '',
  /no activity/i,
  'live SSE errors use the emitted error code for the same banner as reload',
);

assert.equal(runFailureNoticeForState({ liveRun: liveErrorRun, latestAgentRun: { ...failedPersistedRun, runId: 'newer-success', status: 'done', startedAt: 400 } }), null, 'a stale error snapshot cannot override newer persisted success');
assert.ok(runFailureNoticeForState({ liveRun: { ...streamingLiveRun, status: 'done' }, latestAgentRun: { ...failedPersistedRun, runId: 'newer-failure', startedAt: 400 } }), 'stale live success cannot hide a newer durable failure');

const staleLiveRun = { ...streamingLiveRun, startedAt: 50 };
assert.equal(currentLiveRun(staleLiveRun, failedPersistedRun), null, 'newer history excludes stale streaming state and messages, not only its banner');
assert.equal(currentLiveRun(staleLiveRun, { ...failedPersistedRun, status: 'done' }), null);
assert.equal(currentLiveRun(streamingLiveRun, failedPersistedRun), streamingLiveRun, 'new runs remain busy');
assert.equal(currentLiveRun(streamingLiveRun, null), streamingLiveRun);
assert.equal(currentLiveRun(null, failedPersistedRun), null);
assert.equal(canManuallySendQueuedMessage({taskBusyForQueue: currentLiveRun(staleLiveRun, failedPersistedRun)?.status === 'streaming', configPending: false, queuedIsSending: false}), true);

const rendered = renderToStaticMarkup(createElement(RunFailureBanner, { notice: iterationNotice }));
assert.match(rendered, /Run paused/);
assert.match(rendered, /tool-iteration/);
assert.match(rendered, /unfinished/);
assert.equal(renderToStaticMarkup(createElement(RunFailureBanner, { notice: null })), '');

const hydratedReadyQueue = {
  queuedMessageId: 'queue-1',
  taskBusyForQueue: false,
  configPending: false,
  queuedSendError: null,
  loadedTaskId: 'task-1',
  queueHydratedTaskId: 'task-1',
  taskId: 'task-1',
};
assert.equal(shouldAutoSendQueuedMessage({ ...hydratedReadyQueue, pausedByRunFailure: false }), true);
assert.equal(
  shouldAutoSendQueuedMessage({ ...hydratedReadyQueue, pausedByRunFailure: true }),
  false,
  'a queued follow-up stays queued after an error/stopped run instead of auto-delivering',
);
assert.equal(
  canManuallySendQueuedMessage({ taskBusyForQueue: false, configPending: false, queuedIsSending: false }),
  true,
  'manual queued send remains available while auto delivery is paused by the run blocker',
);
assert.equal(queuedMessageWaitingLabel({ pausedByRunFailure: true, compactionBlocker: false }), 'Paused after unfinished run');
assert.equal(queuedMessageWaitingLabel({ pausedByRunFailure: false, compactionBlocker: true }), 'Sends after compaction');

console.log('Run failure presentation tests passed');
