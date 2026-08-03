import assert from 'node:assert/strict';
import { addClient, closeClientsForRestart } from '../server/events.js';
import { closeSubscribersForRestart, subscribe } from '../server/live-chat.js';

function response() {
  const writes: string[] = [];
  let ended = false;
  return {
    writes,
    get ended() { return ended; },
    write(value: string) { writes.push(value); return true; },
    end() { ended = true; },
    on() { return this; },
  };
}

const board = response();
const live = response();
addClient(board as never);
subscribe('task-1', live as never);

closeClientsForRestart();
closeSubscribersForRestart();

for (const client of [board, live]) {
  assert.equal(client.ended, true);
  assert.match(client.writes.join(''), /maintenance_reconnect/);
}

console.log('SSE drain tests passed');
