const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SessionPool} = require('./session-pool.cjs');

test('different keys isolate; duplicate attach fails; reconnect retains worker', () => {
  let created = 0;
  const pool = new SessionPool(() => ({id: ++created, close() {}}), 20);
  const a = pool.attach('a');
  assert.notEqual(a, pool.attach('b'));
  assert.throws(() => pool.attach('a'), /already connected/);
  pool.detach('a', a);
  assert.equal(pool.attach('a'), a);
  pool.close();
});

test('expired workers are closed and replaced', async () => {
  let closed = 0;
  const pool = new SessionPool(() => ({close() {closed++;}}), 5);
  const first = pool.attach('a');
  pool.detach('a', first);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(closed, 1);
  assert.notEqual(pool.attach('a'), first);
  pool.close();
});
