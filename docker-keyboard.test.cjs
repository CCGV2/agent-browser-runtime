// Opt-in smoke test inside a dedicated runtime container. Start its normal
// desktop entrypoint with a test-generated /run/secrets/vnc_password, mount this
// file into the container, and set AGENT_BROWSER_TEST_VNC_PASSWORD to that
// fixture's value. Never point this test at a personal desktop or real secret.
//
// docker exec -e AGENT_BROWSER_TEST_DOCKER_KEYBOARD=1 \
//   -e AGENT_BROWSER_TEST_VNC_PASSWORD=fixture-only CONTAINER \
//   node --test /tmp/docker-keyboard.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');

class FixtureRFB {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.failure = null;
    socket.on('data', bytes => {
      this.buffer = Buffer.concat([this.buffer, bytes]);
      this.deliver();
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(Error('Fixture VNC connection closed')));
  }
  fail(error) {
    this.failure = error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
  deliver() {
    if (!this.pending || this.buffer.length < this.pending.size) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    const bytes = this.buffer.subarray(0, pending.size);
    this.buffer = this.buffer.subarray(pending.size);
    pending.resolve(bytes);
  }
  read(size) {
    assert.equal(this.pending, null, 'Only one fixture read may be outstanding');
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(Error('Fixture VNC read timed out')), 5000);
      this.pending = {size, resolve, reject, timer};
      this.deliver();
    });
  }
  async initialize(password) {
    assert.equal((await this.read(12)).toString(), 'RFB 003.008\n');
    this.socket.write('RFB 003.008\n');
    const count = (await this.read(1))[0];
    assert.ok(count > 0, 'Fixture VNC server must offer authentication');
    const types = await this.read(count);
    assert.ok(types.includes(2), 'Fixture must use VNC password authentication');
    this.socket.write(Buffer.from([2]));
    const challenge = await this.read(16);
    const key = Buffer.alloc(8);
    Buffer.from(password).copy(key, 0, 0, 8);
    for (let i = 0; i < key.length; i++) {
      let value = key[i], reversed = 0;
      for (let bit = 0; bit < 8; bit++) {reversed = (reversed << 1) | (value & 1); value >>>= 1;}
      key[i] = reversed;
    }
    // Three identical DES keys are equivalent to DES, while Node/OpenSSL keeps
    // this cipher available without enabling the legacy provider.
    const cipher = crypto.createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    this.socket.write(Buffer.concat([cipher.update(challenge), cipher.final()]));
    key.fill(0);
    assert.equal((await this.read(4)).readUInt32BE(0), 0, 'Fixture VNC authentication failed');
    this.socket.write(Buffer.from([1])); // Share the dedicated fixture display.
    const init = await this.read(24);
    await this.read(init.readUInt32BE(20)); // Desktop name.
  }
  key(keysym, down) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym, 4);
    this.socket.write(message);
  }
  press(keysym) {this.key(keysym, true); this.key(keysym, false);}
  text(value) {
    for (const char of value) {
      const point = char.codePointAt(0);
      this.press(point > 0xff ? 0x01000000 | point : point);
    }
  }
  async committedText(value) {
    const child = spawn('/usr/bin/flock',['-n','/tmp/agent-browser-desktop-text.lock',process.execPath,'/opt/agent-browser/desktop-text.cjs'],{stdio:['pipe','pipe','pipe']});
    const chunks=[];
    child.stdout.on('data',bytes=>chunks.push(bytes));
    child.stderr.on('data',()=>{});
    child.stdin.end(JSON.stringify({text:value}));
    const timer = setTimeout(()=>child.kill('SIGTERM'),7000);
    const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    clearTimeout(timer);
    const response = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(code,0,JSON.stringify(response));
    assert.deepEqual(response,{ok:true,dispatched:true});
  }
}

async function waitForDisplayValue(input, expected) {
  const deadline = Date.now() + 5000;
  let actual;
  while (Date.now() < deadline) {
    actual = await input.inputValue();
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(actual, expected, 'Actual Chromium input must match received RFB characters');
}

test('Docker Xvfb/x11vnc types case, symbols and committed Unicode without lock-state dependence', {
  skip: process.env.AGENT_BROWSER_TEST_DOCKER_KEYBOARD !== '1',
  timeout: 45000,
}, async t => {
  const password = process.env.AGENT_BROWSER_TEST_VNC_PASSWORD;
  assert.ok(password, 'Provide a test-generated VNC password through AGENT_BROWSER_TEST_VNC_PASSWORD');
  const {chromium} = require('/opt/agent-browser/node_modules/playwright-core');
  const fixture = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Keyboard fixture</title><label>Fixture text<textarea id="input" style="display:block;width:800px;height:300px;font-size:28px"></textarea></label>');
  });
  t.after(() => {fixture.closeAllConnections(); fixture.close();});
  await new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const browser = await chromium.launch({
    headless: false,
    chromiumSandbox: true,
    env: {...process.env, DISPLAY: process.env.DISPLAY || ':99'},
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${fixture.address().port}`);
  await page.bringToFront();
  const input = page.locator('#input');
  await input.click();
  const socket = net.createConnection({host: '127.0.0.1', port: 5900});
  t.after(() => socket.destroy());
  const rfb = new FixtureRFB(socket);
  await rfb.initialize(password);

  const Shift = 0xffe1, Control = 0xffe3, CapsLock = 0xffe5;
  const NumLock = 0xff7f, Backspace = 0xff08;
  // Fresh characters on every run expose x11vnc/Chromium's initial keymap race.
  // Reusing a fixed phrase can incorrectly pass once a prior run warmed the map.
  const chosen = new Set();
  function freshChinese() {
    const points = [];
    while (points.length < 5) {
      const point = crypto.randomInt(0x4e00, 0xa000);
      if (!chosen.has(point)) {chosen.add(point); points.push(point);}
    }
    return String.fromCodePoint(...points);
  }
  const unicode = freshChinese(), laterUnicode = Array.from({length:25},()=>freshChinese()).join('');
  rfb.text('a');
  rfb.key(Shift, true); rfb.text('A'); rfb.key(Shift, false);
  await waitForDisplayValue(input, 'aA');

  // A Mac viewer may send a CapsLock pulse for a local input-method change.
  // It must not leave a second, inverted lock state inside Xvfb.
  rfb.press(CapsLock);
  rfb.text('Aa');
  const punctuation = '!@#$%^&*()_+{}:"<>?';
  rfb.key(Shift, true); rfb.text(punctuation); rfb.key(Shift, false);
  await rfb.committedText(unicode);
  await waitForDisplayValue(input, 'aAAa' + punctuation + unicode);

  rfb.press(CapsLock); rfb.press(NumLock);
  rfb.key(Control, true); rfb.text('a'); rfb.key(Control, false);
  rfb.press(Backspace);
  await waitForDisplayValue(input, '');
  // Actual committed text bypasses X11's finite dynamic keysym mapping slots.
  // Include more than 100 distinct first-use characters, with literal symbols.
  const committed = punctuation + 'aA' + laterUnicode + ' 🧪\n$(printf literal); `id`';
  await rfb.committedText(committed);
  await waitForDisplayValue(input, committed);
});
