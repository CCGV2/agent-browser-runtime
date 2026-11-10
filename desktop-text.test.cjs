const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {validateRequest} = require('./desktop-text.cjs');

test('desktop text validation preserves Unicode, punctuation and literal shell syntax', () => {
  const text = '中文 Aa !@#$%^&*() 🧪\n$(touch /tmp/never-executed); `id`';
  assert.equal(validateRequest({text}),text);
});

test('desktop text rejects malformed, oversized and lossy input before any desktop access', () => {
  for (const request of [null,[],{}, {text:1}, {text:'x',command:'id'}, {text:'\0'}, {text:'\ud800'}, {text:'x'.repeat(2001)}])
    assert.throws(()=>validateRequest(request),/INVALID_DESKTOP_TEXT/);
});

test('desktop text CLI never echoes input on rejection and permits empty no-op without X11', () => {
  const script = path.join(__dirname,'desktop-text.cjs');
  const secret = 'REJECTED_INPUT_SENTINEL';
  const rejected = spawnSync(process.execPath,[script],{input:JSON.stringify({text:secret,command:'id'}),encoding:'utf8',timeout:2000});
  assert.equal(rejected.status,1);
  assert.deepEqual(JSON.parse(rejected.stdout),{error:'INVALID_DESKTOP_TEXT',dispatched:false});
  assert.doesNotMatch(rejected.stdout+rejected.stderr,/REJECTED_INPUT_SENTINEL/);
  const empty = spawnSync(process.execPath,[script],{input:'{"text":""}',encoding:'utf8',timeout:2000});
  assert.equal(empty.status,0);
  assert.deepEqual(JSON.parse(empty.stdout),{ok:true,dispatched:false});
});
