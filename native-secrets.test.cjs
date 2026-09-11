const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {SecretStore} = require('./native-secrets.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-secrets-'));
  fs.mkdirSync(path.join(dir, 'control'));
  const root = fs.realpathSync(dir); let now = Date.now();
  const store = new SecretStore(dir, {root, now:() => now});
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const binding = {session:'test-session', origin:'https://example.com', target:'#password'};
  function register() {
    const file = path.join(root, crypto.randomBytes(16).toString('hex'));
    const value = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, value, {mode:0o600});
    const grant = store.register({...binding, fileRef:'file:'+file, ttlMs:1000});
    assert.equal(fs.existsSync(file), false);
    assert.equal(JSON.stringify(grant).includes(value), false);
    return {...grant, value};
  }
  return {dir, root, store, binding, register, advance:() => now += 2000};
}
test('secret is single use, removes payload, and persists the observation hold', t => {
  const f = fixture(t); const grant = f.register();
  assert.equal(f.store.consume({...f.binding, secret_ref:grant.secret_ref}).value, grant.value);
  assert.deepEqual(fs.readdirSync(f.store.dir), []);
  assert.throws(() => f.store.consume({...f.binding, secret_ref:grant.secret_ref}));
  const restarted = new SecretStore(f.dir, {root:f.root});
  assert.ok(restarted.holds.has(f.binding.session));
  restarted.resume(f.binding.session);
  assert.equal(new SecretStore(f.dir, {root:f.root}).holds.size, 0);
});
test('expiry and wrong session/origin/target destroy the one-use payload', t => {
  const f = fixture(t);
  for (const field of ['session','origin','target']) {
    const grant = f.register();
    assert.throws(() => f.store.consume({...f.binding, [field]:'wrong', secret_ref:grant.secret_ref}));
    assert.deepEqual(fs.readdirSync(f.store.dir), []);
    assert.throws(() => f.store.consume({...f.binding, secret_ref:grant.secret_ref}));
  }
  f.register(); f.advance(); f.store.sweep();
  assert.deepEqual(fs.readdirSync(f.store.dir), []);
});
test('arbitrary paths, symlinks, permissive files and stale files cannot be registered', t => {
  const f = fixture(t); const file = path.join(f.root, 'a'.repeat(32));
  fs.writeFileSync(file, 'synthetic', {mode:0o644});
  assert.throws(() => f.store.register({...f.binding, fileRef:'file:'+file}));
  fs.chmodSync(file, 0o600); fs.utimesSync(file, new Date(0), new Date(0));
  assert.throws(() => f.store.register({...f.binding, fileRef:'file:'+file}));
  const link = path.join(f.root, 'b'.repeat(32)); fs.symlinkSync(file, link);
  assert.throws(() => f.store.register({...f.binding, fileRef:'file:'+link}));
  assert.throws(() => f.store.register({...f.binding, fileRef:'file:/etc/passwd'}));
});
