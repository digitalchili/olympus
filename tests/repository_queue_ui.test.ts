import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RepositoryQueueNotice } from '../client/src/components/RepositoryQueueNotice.js';
import type { Task } from '../shared/types.js';

const html = renderToStaticMarkup(createElement(RepositoryQueueNotice, { queue: {
  state: 'waiting', waitingForTaskId: 'a', message: 'Waiting for “Implement login” to finish.',
} }));
assert.match(html, /Waiting for “Implement login” to finish/);
assert.match(html, /start automatically/);
assert.doesNotMatch(html, /Approve|branch|lease|fence/i);
const blocked = renderToStaticMarkup(createElement(RepositoryQueueNotice, { queue: {
  state: 'blocked', waitingForTaskId: 'a', message: 'Waiting for “Implement login” to be ready. Its checks need attention.',
} }));
assert.match(blocked, /checks need attention/);
assert.match(blocked, /saved/i);
assert.equal(renderToStaticMarkup(createElement(RepositoryQueueNotice, { queue: undefined })), '');
const task = { id: 'b', title: 'Add settings', kind: 'task', updated_at: 100, last_viewed_at: null } as Task;
globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
const { useStore } = await import('../client/src/lib/store.js');
useStore.getState().upsertTask(task);
useStore.getState().upsertTask({ ...task, repositoryQueue: { state: 'waiting', waitingForTaskId: 'a', message: 'Waiting for A to finish.' } });
assert.equal(useStore.getState().tasks[0]?.repositoryQueue?.message, 'Waiting for A to finish.', 'board events update waiting state without changing the task itself');
useStore.getState().upsertTask(task);
assert.equal(useStore.getState().tasks[0]?.repositoryQueue, undefined, 'a started task loses its waiting notice');
console.log('Repository queue explanations render correctly');
