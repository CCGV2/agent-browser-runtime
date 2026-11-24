const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {stopWorker} = require('./worker-stop.cjs');

function worker() {
  const child = new EventEmitter();
  Object.assign(child, {pid: 1, exitCode: null, signalCode: null, events: []});
  child.stdin = {end() {child.events.push('stdin-end');}};
  child.kill = signal => child.events.push(signal);
  return child;
}
test('given a running worker, waits for graceful close before resolving', async () => {
  const child = worker();
  let completed = false;
  const stopped = stopWorker(child).then(() => {completed = true;});
  assert.deepEqual(child.events, ['stdin-end', 'SIGTERM']);
  await Promise.resolve();
  assert.equal(completed, false);
  child.emit('close');
  await stopped;
  assert.equal(completed, true);
});
test('given an unresponsive worker, force kills only after the shutdown deadline', async () => {
  const child = worker();
  const stopped = stopWorker(child, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(child.events, ['stdin-end', 'SIGTERM', 'SIGKILL']);
  child.emit('close');
  await stopped;
});
test('given an exited or unspawned worker, close does not signal another process', async () => {
  for (const state of [{exitCode: 0}, {signalCode: 'SIGTERM'}, {pid: undefined}]) {
    const child = Object.assign(worker(), state);
    await stopWorker(child);
    assert.deepEqual(child.events, []);
  }
});
test('given recording finalization, waits for the response before terminating the worker', async () => {
  const child = worker();
  let finish;
  const response = new Promise(resolve => {finish = resolve;});
  const stopped = stopWorker(child, 1000, () => {child.events.push('finalize'); return response;});
  await Promise.resolve();
  assert.deepEqual(child.events, ['finalize']);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.events, ['finalize', 'stdin-end', 'SIGTERM']);
  child.emit('close');
  await stopped;
});
test('given a failed finalization, still closes the worker; a hung finalization remains bounded', async () => {
  const failed = worker();
  const stopped = stopWorker(failed, 1000, async () => {throw Error('closed');});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failed.events, ['stdin-end', 'SIGTERM']);
  failed.emit('close');
  await stopped;
  const hung = worker();
  const bounded = stopWorker(hung, 5, () => new Promise(() => {}));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(hung.events, ['SIGKILL']);
  hung.emit('close');
  await bounded;
});
