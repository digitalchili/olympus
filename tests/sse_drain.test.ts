import assert from 'node:assert/strict';
import { addClient, broadcast as broadcastBoard, closeClientsForProfile, closeClientsForRestart } from '../server/events.js';
import { broadcast as broadcastLive, closeSubscribersForRestart, closeSubscribersForTasks, subscribe } from '../server/live-chat.js';

function response() {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  let ended = false;
  return {
    writes,
    get ended() { return ended; },
    write(value: string) { writes.push(value); return true; },
    end() { ended = true; },
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return this;
    },
    emitClose() {
      for (const handler of closeHandlers) handler();
    },
  };
}

const board = response();
const live = response();
addClient(board as never, { id: 'default', isDefault: true } as never);
subscribe('task-1', live as never);

closeClientsForProfile('default');
closeSubscribersForTasks(['task-1']);

assert.equal(board.ended, true);
assert.equal(live.ended, true);

const replacementBoard = response();
const replacementLive = response();
addClient(replacementBoard as never, { id: 'default', isDefault: true } as never);
subscribe('task-1', replacementLive as never);
live.emitClose();
broadcastBoard({
  type: 'task_updated',
  task: { id: 'task-1', profile_name: 'default' } as never,
});
broadcastLive('task-1', { type: 'text_delta', content: 'replacement data' });

assert.equal(board.writes.join('').includes('task-1'), false, 'revoked board client must stay detached');
assert.equal(live.writes.join('').includes('replacement data'), false, 'revoked live client must stay detached');
assert.equal(replacementBoard.writes.join('').includes('task-1'), true);
assert.equal(replacementLive.writes.join('').includes('replacement data'), true);

closeClientsForRestart();
closeSubscribersForRestart();

for (const client of [replacementBoard, replacementLive]) {
  assert.equal(client.ended, true);
  assert.match(client.writes.join(''), /maintenance_reconnect/);
}

console.log('SSE drain tests passed');
