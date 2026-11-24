const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseRecording, prepareRecording} = require('./recording.cjs');

test('given no recording opt-in, recording stays disabled; invalid values fail clearly', () => {
  for (const value of [undefined, '', '0', 'false']) assert.equal(parseRecording(value), false);
  for (const value of ['1', 'true']) assert.equal(parseRecording(value), true);
  for (const value of ['yes', 'TRUE', '2']) assert.throws(() => parseRecording(value), /AGENT_BROWSER_RECORD_VIDEO/);
});

test('given recording opt-in, creates private configuration and unique per-worker video directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-config-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const off = prepareRecording(path.join(root, 'off'), false);
  assert.deepEqual(off, {directory: path.join(root, 'off')});
  assert.deepEqual(fs.readdirSync(off.directory), []);
  const first = prepareRecording(path.join(root, 'on'), true);
  const second = prepareRecording(path.join(root, 'on'), true);
  assert.notEqual(first.directory, second.directory);
  assert.equal(path.dirname(first.directory), path.join(root, 'on'));
  assert.equal(first.videoDirectory, path.join(first.directory, 'videos'));
  assert.equal(fs.statSync(first.videoDirectory).isDirectory(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.configPath)), {
    browser: {contextOptions: {recordVideo: {dir: first.videoDirectory, size: {width: 1440, height: 900}}}},
  });
  assert.equal(fs.statSync(first.configPath).mode & 0o777, 0o600);
});
