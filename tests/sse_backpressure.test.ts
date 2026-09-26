import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import type { Response } from 'express';
import { addClient, addProjectClient, bootstrapEvents, broadcast as boardBroadcast, closeClientsForRestart } from '../server/events.js';
import { broadcast as liveBroadcast, closeSubscribersForRestart, subscribe } from '../server/live-chat.js';

// Real Node backpressure: write(false) has accepted the chunk. Only its callback
// drains the buffer. No HTTP server, model or real application state is used.
class ControlledResponse extends Writable {
  readonly writes: string[] = [];
  private callbacks: Array<(error?: Error | null) => void> = [];
  constructor(private immediate = false) { super({ highWaterMark: immediate ? 1_000_000 : 1 }); }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(chunk.toString());
    if (this.immediate) callback();
    else this.callbacks.push(callback);
  }
  async drainOne() {
    const callback = this.callbacks.shift();
    assert.ok(callback, 'expected an accepted write waiting for drain');
    callback();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  get response() { return this as unknown as Response; }
}

const profile = { id: 'default', isDefault: true } as never;
const task = { id: 'task-sse', profile_name: 'default', project_id: 'project-sse' } as never;
try {
  const slow = new ControlledResponse();
  addClient(slow.response, profile).bootstrap([]);
  boardBroadcast({ type: 'task_updated', task });
  await slow.drainOne();
  boardBroadcast({ type: 'task_updated', task });
  assert.equal(slow.writes.length, 2, 'an accepted false write must not silently unsubscribe the board client');
  await slow.drainOne();
  slow.end();

  const { createSseWriter } = await import('../server/sse-writer.js');
  {
    const res = new ControlledResponse();
    bootstrapEvents(addClient(res.response, profile), [
      { type: 'task_runs_snapshot', runs: [] },
      { type: 'delegations_snapshot', runs: [] },
    ]);
    assert.match(res.writes[0], /task_runs_snapshot/);
    await res.drainOne();
    assert.match(res.writes[1], /delegations_snapshot/);
    await res.drainOne();
    boardBroadcast({ type: 'task_updated', task });
    assert.equal(res.writes.length, 3, 'board bootstrap stays subscribed after both snapshots drain');
    await res.drainOne(); res.end();
  }
  {
    const res = new ControlledResponse();
    const writer = createSseWriter(res.response);
    writer.bootstrap(['data: large-first-snapshot\n\n', 'data: second-snapshot\n\n']);
    assert.deepEqual(res.writes, ['data: large-first-snapshot\n\n']);
    writer.keepalive();
    assert.equal(res.writableLength, Buffer.byteLength(res.writes[0]), 'keepalive must not grow a blocked buffer');
    await res.drainOne();
    assert.deepEqual(res.writes, ['data: large-first-snapshot\n\n', 'data: second-snapshot\n\n']);
    await res.drainOne();
    assert.equal(res.writableEnded, false, 'large bootstrap frames alone must not create a reconnect loop');
    writer.send('data: after-bootstrap\n\n');
    await res.drainOne();
    assert.deepEqual(res.writes, ['data: large-first-snapshot\n\n', 'data: second-snapshot\n\n', 'data: after-bootstrap\n\n']);
    writer.close();
  }
  {
    const res = new ControlledResponse();
    const writer = createSseWriter(res.response);
    writer.bootstrap(['data: first\n\n', 'data: second\n\n']);
    for (let i = 0; i < 1000; i++) { writer.send('data: missed-delta\n\n'); writer.keepalive(); }
    assert.equal(res.writes.length, 1);
    assert.equal(res.writableLength, Buffer.byteLength('data: first\n\n'), 'missed increments are represented by one resync flag, not an event queue');
    await res.drainOne();
    assert.equal(res.writableEnded, false, 'the second bootstrap frame must finish before resync closes the stream');
    await res.drainOne();
    assert.equal(res.writableEnded, true, 'missed state closes the stream so EventSource can load a fresh snapshot');
    assert.deepEqual(res.writes, ['data: first\n\n', 'data: second\n\n']);
    const writes = res.writes.length;
    res.emit('drain'); writer.send('data: late\n\n'); writer.close();
    assert.equal(res.writes.length, writes);
    for (const event of ['drain', 'close', 'error', 'finish']) assert.equal(res.listenerCount(event), 0, `${event} listener cleaned`);
  }
  {
    const res = new ControlledResponse();
    const writer = createSseWriter(res.response);
    writer.send('data: update-racing-bootstrap\n\n');
    writer.bootstrap(['data: snapshot\n\n']);
    await res.drainOne();
    assert.equal(res.writableEnded, true, 'an update racing registration/bootstrap must request resync');
    assert.deepEqual(res.writes, ['data: snapshot\n\n']);
  }
  {
    const res = new ControlledResponse();
    const writer = createSseWriter(res.response);
    writer.bootstrap([]); writer.keepalive();
    await res.drainOne();
    assert.equal(res.writableEnded, false, 'backpressure from keepalive alone is harmless');
    writer.send('data: next\n\n'); await res.drainOne();
    writer.close();
  }
  for (const event of ['error', 'close']) {
    const res = new ControlledResponse();
    const writer = createSseWriter(res.response);
    writer.bootstrap(['data: snapshot\n\n', 'data: never\n\n']);
    res.emit(event, new Error('fixture disconnected'));
    await res.drainOne();
    assert.deepEqual(res.writes, ['data: snapshot\n\n']);
    assert.equal(res.writableEnded, true);
    for (const event of ['drain', 'close', 'error', 'finish']) assert.equal(res.listenerCount(event), 0);
  }
  {
    const res = new ControlledResponse(true);
    res.write = () => { throw new Error('fixture write failed'); };
    const writer = createSseWriter(res.response);
    writer.bootstrap(['data: snapshot\n\n']);
    assert.equal(res.writableEnded, true, 'a thrown write ends the response instead of leaving a silent socket');
    for (const event of ['drain', 'close', 'error', 'finish']) assert.equal(res.listenerCount(event), 0);
  }
  {
    const slow = new ControlledResponse();
    const fast = new ControlledResponse(true);
    addProjectClient(slow.response, 'project-sse').bootstrap(['data: project-snapshot\n\n']);
    addProjectClient(fast.response, 'project-sse').bootstrap([]);
    boardBroadcast({ type: 'task_updated', task });
    await slow.drainOne();
    assert.equal(slow.writableEnded, true);
    boardBroadcast({ type: 'task_updated', task });
    assert.equal(fast.writes.length, 2, 'a blocked project client cannot interrupt another subscriber');
    assert.equal(fast.writableEnded, false);
    fast.end();
  }
  {
    const slow = new ControlledResponse();
    const writer = subscribe('task-live-sse', slow.response);
    writer.bootstrap(['data: live-snapshot\n\n']);
    await slow.drainOne();
    assert.equal(slow.writableEnded, false, 'large live snapshot retains the subscription');
    liveBroadcast('task-live-sse', { type: 'text_delta', content: 'accepted' });
    liveBroadcast('task-live-sse', { type: 'done', sessionId: 'task-live-sse' });
    await slow.drainOne();
    assert.equal(slow.writableEnded, true);
    const replacement = new ControlledResponse(true);
    subscribe('task-live-sse', replacement.response).bootstrap(['data: latest-terminal-snapshot\n\n']);
    liveBroadcast('task-live-sse', { type: 'text_delta', content: 'replacement-only' });
    assert.equal(slow.writes.length, 2);
    assert.equal(replacement.writes.length, 2, 'closing old transport must not detach replacement');
    replacement.end();
  }
} finally {
  closeClientsForRestart();
  closeSubscribersForRestart();
}
console.log('SSE backpressure and bootstrap tests passed');
