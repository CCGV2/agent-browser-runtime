const {test} = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const readline = require('node:readline');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {once} = require('node:events');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {return await check();} catch (caught) {error = caught;}
    await sleep(20);
  } while (Date.now() < deadline);
  throw Error(description + ': ' + error?.message);
}

function messages(input) {
  const waiting = [];
  const buffered = [];
  const lines = readline.createInterface({input});
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (waiting.length) waiting.shift()(message);
    else buffered.push(message);
  });
  return () => buffered.length ? Promise.resolve(buffered.shift()) : new Promise(resolve => waiting.push(resolve));
}

async function withTimeout(promise, description, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(description + ' timed out')), ms);
    })]);
  } finally {clearTimeout(timer);}
}

function rpcClient(output, input) {
  const next = messages(input);
  let id = 1;
  return {
    next,
    async rpc(method, params = {}) {
      const requestID = id++;
      output.write(JSON.stringify({jsonrpc: '2.0', id: requestID, method, params}) + '\n');
      return withTimeout((async () => {
        for (;;) {const message = await next(); if (message.id === requestID && !message.method) return message;}
      })(), method, 30000);
    },
    notify(method, params = {}) {output.write(JSON.stringify({jsonrpc: '2.0', method, params}) + '\n');},
  };
}

async function startBroker(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-recording-'));
  const socketPath = path.join(directory, 'broker.sock');
  const environment = {...process.env,
    AGENT_BROWSER_SOCKET: socketPath,
    AGENT_BROWSER_ARTIFACT_DIR: directory,
    AGENT_BROWSER_MCP_CLI: path.join(__dirname, 'test/recording-mcp.cjs'),
    ...extra,
  };
  delete environment.AGENT_BROWSER_RECORD_VIDEO;
  const broker = spawn(process.execPath, [path.join(__dirname, 'browser-broker.cjs')], {
    env: environment, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.on('data', data => {stderr += data;});
  const exit = once(broker, 'exit');
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGTERM');
    await withTimeout(exit, 'broker cleanup');
    await fs.rm(directory, {recursive: true, force: true});
  });
  await eventually(async () => {
    assert.equal(broker.exitCode, null, stderr);
    await fs.stat(socketPath);
  }, 'broker socket');
  const connect = async handshake => {
    const socket = net.connect(socketPath);
    socket.on('error', () => {});
    const client = {...rpcClient(socket, socket), socket};
    clients.push(client);
    await once(socket, 'connect');
    socket.write(JSON.stringify(handshake) + '\n');
    client.attachment = await withTimeout(client.next(), 'attachment');
    return client;
  };
  return {directory, socketPath, broker, exit, environment, connect};
}

async function initialize(client) {
  const response = await client.rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'recording-test', version: '1'},
  });
  assert.ok(response.result, JSON.stringify(response));
  client.notify('notifications/initialized');
  return client;
}

async function read(client) {return (await client.rpc('read')).result;}
function sessionDirectory(root, key) {return path.join(root, createHash('sha256').update(key).digest('hex'));}

test('given no recording option, the broker keeps the existing artifact layout without recording config', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  for (const [key, options] of [['default', {}], ['disabled', {recordVideo: false}]]) {
    const client = await initialize(await broker.connect({sessionKey: key, ...options}));
    assert.deepEqual(client.attachment, {attached: true});
    const state = await read(client);
    assert.equal(state.outputDir, sessionDirectory(broker.directory, key));
    assert.equal(state.configPath, null);
    assert.equal(state.config, null);
    assert.equal(state.argv.includes('--config'), false);
    const close = await client.rpc('tools/call', {name: 'browser_close', arguments: {}});
    assert.deepEqual(close.result.content, [{type: 'text', text: 'Closed browser.'}]);
  }
});

test('given recording opt-in, the broker creates private per-run config and returns the video directory', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  const client = await initialize(await broker.connect({sessionKey: 'recorded', recordVideo: true}));
  assert.equal(client.attachment.attached, true);
  const state = await read(client);
  assert.equal(path.dirname(state.outputDir), sessionDirectory(broker.directory, 'recorded'));
  assert.match(path.basename(state.outputDir), /^[a-f0-9-]{36}$/i);
  assert.equal(state.configPath, path.join(state.outputDir, 'mcp-config.json'));
  assert.equal(client.attachment.recording.directory, path.join(state.outputDir, 'videos'));
  assert.deepEqual(state.config.browser.contextOptions.recordVideo, {
    dir: client.attachment.recording.directory,
    size: {width: 1440, height: 900},
  });
  assert.deepEqual(JSON.parse(await fs.readFile(state.configPath, 'utf8')), state.config);
  const close = await client.rpc('tools/call', {name: 'browser_close', arguments: {}});
  assert.ok(close.result.content.some(item => item.type === 'text' && item.text.includes(client.attachment.recording.directory)));
});

test('given invalid private recording options, attach fails before creating a worker', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  for (const value of ['true', 'false', 1, 0, null, {}, []]) {
    const client = await broker.connect({sessionKey: 'invalid-' + JSON.stringify(value), recordVideo: value});
    assert.match(client.attachment.error, /record|option|boolean/i);
    assert.equal(client.attachment.attached, undefined);
  }
  assert.deepEqual((await fs.readdir(broker.directory)).filter(name => name !== 'broker.sock'), []);
});

test('given a retained session, matching options reconnect while mismatches preserve the original worker', {timeout: 15000}, async t => {
  const broker = await startBroker(t);
  for (const enabled of [false, true]) {
    const key = 'retained-' + enabled;
    const first = await initialize(await broker.connect({sessionKey: key, recordVideo: enabled}));
    const state = await read(first);
    first.socket.destroy();
    await sleep(40);
    const mismatch = await broker.connect({sessionKey: key, recordVideo: !enabled});
    assert.match(mismatch.attachment.error, /options/i);
    await sleep(20);
    const resumed = await initialize(await broker.connect({sessionKey: key, recordVideo: enabled}));
    assert.equal((await read(resumed)).pid, state.pid);
    assert.deepEqual(resumed.attachment, first.attachment);
  }
});

test('given worker retirement, the next recording run has a new directory and the old worker flushes', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  const first = await initialize(await broker.connect({sessionKey: 'new-run', recordVideo: true}));
  const old = await read(first);
  // Activity IPC updates the generation before the worker emits its idle event.
  await first.rpc('tools/call', {name: 'fixture', arguments: {}});
  const closed = once(first.socket, 'close');
  first.notify('simulate-idle');
  await withTimeout(closed, 'idle disconnect');
  await assert.rejects(fs.stat(path.join(old.outputDir, 'worker-flushed.json')), {code: 'ENOENT'});
  const next = await initialize(await broker.connect({sessionKey: 'new-run', recordVideo: true}));
  const current = await read(next);
  assert.notEqual(current.pid, old.pid);
  assert.notEqual(current.outputDir, old.outputDir);
  assert.notEqual(next.attachment.recording.directory, first.attachment.recording.directory);
  await eventually(() => fs.stat(path.join(old.outputDir, 'worker-flushed.json')), 'retired worker flush');
});

test('given an unexpectedly exited worker, the broker disconnects it and starts a fresh recording run', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  const first = await initialize(await broker.connect({sessionKey: 'crashed', recordVideo: true}));
  const old = await read(first);
  const disconnected = once(first.socket, 'close');
  first.notify('crash');
  await withTimeout(disconnected, 'crashed worker disconnect');
  const replacement = await initialize(await broker.connect({sessionKey: 'crashed', recordVideo: true}));
  const fresh = await read(replacement);
  assert.notEqual(fresh.pid, old.pid);
  assert.notEqual(fresh.outputDir, old.outputDir);
});

test('given recording environment options, the stdio adapter opts in only for explicit enabled values', {timeout: 20000}, async t => {
  const broker = await startBroker(t);
  for (const [index, value] of ['', '0', 'false', '1', 'true'].entries()) {
    const child = spawn(process.execPath, [path.join(__dirname, 'browser-client.cjs')], {
      env: {...broker.environment, AGENT_BROWSER_SESSION_KEY: 'adapter-' + index, AGENT_BROWSER_RECORD_VIDEO: value},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', data => {stderr += data;});
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await withTimeout(exited, 'adapter cleanup');
    });
    const adapter = rpcClient(child.stdin, child.stdout);
    await initialize(adapter);
    const state = await read(adapter);
    const enabled = ['1', 'true'].includes(value);
    assert.equal(state.config !== null, enabled, 'recording value ' + JSON.stringify(value));
    if (enabled) {
      const videos = state.config.browser.contextOptions.recordVideo.dir;
      await eventually(async () => assert.ok(stderr.includes(videos)), 'recording directory stderr');
      const close = await adapter.rpc('tools/call', {name: 'browser_close', arguments: {}});
      assert.ok(close.result.content.some(item => item.text?.includes(videos)));
    }
    child.stdin.end();
    assert.equal((await withTimeout(exited, 'adapter exit'))[0], 0);
  }
});

test('given invalid recording environment values, the adapter fails clearly before connecting', {timeout: 10000}, async () => {
  for (const value of ['yes', '2', 'TRUE', ' false ', 'off', 'on']) {
    const child = spawn(process.execPath, [path.join(__dirname, 'browser-client.cjs')], {
      env: {...process.env, AGENT_BROWSER_SOCKET: '/nonexistent-recording-test.sock', AGENT_BROWSER_RECORD_VIDEO: value},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => {stderr += data;});
    const [code] = await withTimeout(once(child, 'exit'), 'invalid adapter exit');
    assert.equal(code, 1);
    assert.match(stderr, /AGENT_BROWSER_RECORD_VIDEO|record.*option/i);
    assert.doesNotMatch(stderr, /ENOENT|ECONNREFUSED/);
  }
});

test('given broker shutdown, it waits for all current and already-retiring workers to flush', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  const retiring = await initialize(await broker.connect({sessionKey: 'retiring', recordVideo: true}));
  const active = await initialize(await broker.connect({sessionKey: 'active', recordVideo: true}));
  const states = await Promise.all([read(retiring), read(active)]);
  const disconnected = once(retiring.socket, 'close');
  retiring.notify('simulate-idle');
  await withTimeout(disconnected, 'retiring client disconnect');
  const started = Date.now();
  broker.broker.kill('SIGTERM');
  assert.equal((await withTimeout(broker.exit, 'graceful broker exit'))[0], 0);
  assert.ok(Date.now() - started >= 100, 'broker exit must wait for delayed worker artifact flush');
  for (const state of states) {
    const marker = JSON.parse(await fs.readFile(path.join(state.outputDir, 'worker-flushed.json'), 'utf8'));
    assert.equal(marker.pid, state.pid);
    assert.match(marker.reason, /SIGTERM|stdin/);
  }
});

test('given a connection without an identity handshake, broker shutdown closes it and exits', {timeout: 10000}, async t => {
  const broker = await startBroker(t);
  const socket = net.connect(broker.socketPath);
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await once(socket, 'connect');
  const disconnected = once(socket, 'close');
  broker.broker.kill('SIGTERM');
  assert.equal((await withTimeout(broker.exit, 'shutdown with unattached socket'))[0], 0);
  await withTimeout(disconnected, 'unattached socket close');
});

test('real recorded browser contexts finalize playable videos on browser_close, inactivity, and broker shutdown', {
  timeout: 90000, skip: !process.env.AGENT_BROWSER_REAL_MCP_CLI,
}, async t => {
  const broker = await startBroker(t, {
    AGENT_BROWSER_MCP_CLI: path.join(__dirname, 'docker-focus.cjs'),
    AGENT_BROWSER_HEADLESS: '1', AGENT_BROWSER_IDLE_MS: '1500',
  });
  let ffprobe;
  try {execFileSync('ffprobe', ['-version'], {stdio: 'ignore'}); ffprobe = true;} catch {ffprobe = false;}
  const checkVideos = async directory => eventually(async () => {
    const entries = (await fs.readdir(directory)).filter(name => name.endsWith('.webm'));
    assert.ok(entries.length > 0, 'a video was recorded');
    for (const name of entries) {
      const video = path.join(directory, name);
      assert.ok((await fs.stat(video)).size > 0);
      if (ffprobe) {
        const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', video], {encoding: 'utf8'}));
        assert.ok(metadata.streams.some(stream => stream.codec_type === 'video' && stream.width > 0 && stream.height > 0));
      }
    }
    return entries;
  }, 'finalized playable recordings', 10000);
  const browser = async key => {
    const client = await initialize(await broker.connect({sessionKey: key, recordVideo: true}));
    const tools = (await client.rpc('tools/list')).result.tools;
    const runCode = tools.find(tool => /^browser_run_code/.test(tool.name));
    assert.ok(runCode);
    const response = await client.rpc('tools/call', {name: runCode.name, arguments: {
      code: "async page => {await page.setContent('<title>Recorded</title><h1>Recording test</h1>'); await page.waitForTimeout(300);}",
    }});
    assert.ok(response.result && !response.result.isError, JSON.stringify(response));
    return client;
  };
  const explicit = await browser('real-close');
  const closed = await explicit.rpc('tools/call', {name: 'browser_close', arguments: {}});
  assert.ok(closed.result.content.some(item => item.text?.includes(explicit.attachment.recording.directory)));
  await checkVideos(explicit.attachment.recording.directory);
  const idle = await browser('real-idle');
  await withTimeout(once(idle.socket, 'close'), 'real idle retirement', 10000);
  await checkVideos(idle.attachment.recording.directory);
  const active = await browser('real-shutdown');
  broker.broker.kill('SIGTERM');
  assert.equal((await withTimeout(broker.exit, 'real shutdown', 10000))[0], 0);
  await checkVideos(active.attachment.recording.directory);
});
