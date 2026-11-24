const {test} = require('node:test');
const assert = require('node:assert/strict');
const {IdleMonitor} = require('./idle-monitor.cjs');
function fixture() {
  let now = 0, frame = 'a', expired = 0;
  const monitor = new IdleMonitor({timeout: 300000, now: () => now,
    capture: async () => frame, expire: () => expired++});
  return {monitor, time: n => {now = n;}, frame: f => {frame = f;}, expired: () => expired};
}
test('given a static page, expires once after five minutes without operations', async () => {
  const f = fixture(); await f.monitor.check(); f.time(299999); await f.monitor.check();
  assert.equal(f.expired(), 0); f.time(300000); await f.monitor.check(); await f.monitor.check();
  assert.equal(f.expired(), 1);
});
test('given changing pixels, restarts the idle interval', async () => {
  const f = fixture(); await f.monitor.check(); f.time(299000); f.frame('b'); await f.monitor.check();
  f.time(300000); await f.monitor.check(); assert.equal(f.expired(), 0);
  f.time(599000); await f.monitor.check(); assert.equal(f.expired(), 1);
});
test('given an operation, waits until five minutes after completion', async () => {
  const f = fixture(); await f.monitor.check(); f.monitor.begin(); f.time(600000);
  await f.monitor.check(); assert.equal(f.expired(), 0); f.monitor.end();
  f.time(899999); await f.monitor.check(); assert.equal(f.expired(), 0);
  f.time(900000); await f.monitor.check(); assert.equal(f.expired(), 1);
});
test('given failed or overlapping captures, does not incorrectly expire', async () => {
  let resolve, now = 0, expired = false;
  const m = new IdleMonitor({timeout: 10, now: () => now,
    capture: () => new Promise(r => {resolve = r;}), expire: () => {expired = true;}});
  const checking = m.check(); await m.check(); m.begin(); m.end(); now = 20; resolve('a'); await checking;
  assert.equal(expired, false);
  m.capture = async () => {throw Error('closed');}; await m.check(); assert.equal(expired, false);
});
test('given no open page, still expires; validates timeout', async () => {
  assert.throws(() => new IdleMonitor({timeout: -1}), /timeout/);
  const f = fixture(); f.frame(null); await f.monitor.check(); f.time(300000); await f.monitor.check();
  assert.equal(f.expired(), 1);
});

test('given a deferred idle decision, new activity rearms the monitor', async () => {
  const f = fixture(); await f.monitor.check(); f.time(300000); await f.monitor.check();
  assert.equal(f.expired(), 1); f.monitor.reset();
  f.time(599999); await f.monitor.check(); assert.equal(f.expired(), 1);
  f.time(600000); await f.monitor.check(); assert.equal(f.expired(), 2);
});
