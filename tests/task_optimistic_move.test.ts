import assert from 'node:assert/strict';
import type { Task } from '../shared/types.js';
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
const { optimisticMoveTask, useStore } = await import('../client/src/lib/store.js');
const task = { id: 'move-test', title: 'Protected task', status: 'in_review', updated_at: 1, last_viewed_at: null } as Task;
useStore.getState().setTasks([task]);
const failure = new Error('Task history requires repair');
await assert.rejects(optimisticMoveTask(task, 'done', useStore.getState().upsertTask, async () => {
  assert.equal(useStore.getState().tasks[0].status, 'done');
  throw failure;
}), error => error === failure, 'the caller must know the move failed before reporting completion');
assert.equal(useStore.getState().tasks[0].status, 'in_review', 'a rejected move restores the previous status');
await optimisticMoveTask(task, 'done', useStore.getState().upsertTask, async () => ({ task: { ...task, status: 'done', updated_at: 2 } }));
assert.equal(useStore.getState().tasks[0].status, 'done');
console.log('Optimistic task moves report failures and preserve the saved status');
