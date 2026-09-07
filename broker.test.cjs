const {test} = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');

async function connect(socketPath, key) {
  const socket = net.connect(socketPath);
  const waiting = []; const messages = [];
  const lines = readline.createInterface({input: socket});
  lines.on('line', line => { const m = JSON.parse(line); if (waiting.length) waiting.shift()(m); else messages.push(m); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(r => waiting.push(r));
  await once(socket, 'connect');
  socket.write(JSON.stringify({sessionKey: key}) + '\n');
  const attachment = await next();
  return {socket, attachment, async rpc(method, id = 1, params = {}) {
    socket.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    let timer;
    try {
      return await Promise.race([
        (async () => { for (;;) { const m = await next(); if (m.id === id && !m.method) return m; } })(),
        new Promise((_, reject) => {timer = setTimeout(() => reject(Error(method + ' timed out')), 30000);}),
      ]);
    } finally {clearTimeout(timer);}
  }, notify(method) {socket.write(JSON.stringify({jsonrpc: '2.0', method}) + '\n');}};
}

test('broker isolates workers, fences duplicate connections, retains idle state and retires uncertain operations', {timeout: 15000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-broker-'));
  const socketPath = path.join(dir, 'broker.sock');
  const child = spawn(process.execPath, [path.join(__dirname, 'browser-broker.cjs')], {env: {...process.env,
    AGENT_BROWSER_SOCKET: socketPath, AGENT_BROWSER_ARTIFACT_DIR: dir,
    AGENT_BROWSER_MCP_CLI: path.join(__dirname, 'test/fake-mcp.cjs'), AGENT_BROWSER_GRACE_MS: '5000'}, stdio: 'ignore'});
  const clients = [];
  t.after(async () => {for (const c of clients) c.socket.destroy(); const exited = once(child, 'exit'); child.kill(); await exited; await fs.rm(dir, {recursive: true, force: true});});
  for (let i = 0; i < 100; i++) {
    try {await fs.stat(socketPath); break;} catch {await new Promise(r => setTimeout(r, 20));}
  }
  const attach = async key => {const c = await connect(socketPath, key); clients.push(c); return c;};
  const a = await attach('a'); const b = await attach('b');
  await a.rpc('initialize'); a.notify('notifications/initialized');
  await b.rpc('initialize'); b.notify('notifications/initialized');
  const state = (await a.rpc('increment', 2)).result;
  assert.equal(state.initialized, true);
  assert.notEqual(state.pid, (await b.rpc('read', 2)).result.pid);
  const duplicate = await attach('a'); assert.match(duplicate.attachment.error, /already connected/);
  a.socket.destroy(); await new Promise(r => setTimeout(r, 50));
  const resumed = await attach('a'); await resumed.rpc('initialize', 42);
  assert.deepEqual((await resumed.rpc('read', 43)).result, state);
  resumed.notify('hang'); // Notifications do not create an in-flight request.
  resumed.socket.write(JSON.stringify({jsonrpc: '2.0', id: 44, method: 'hang'}) + '\n');
  await new Promise(r => setTimeout(r, 30)); resumed.socket.destroy();
  await new Promise(r => setTimeout(r, 50));
  const fresh = await attach('a'); await fresh.rpc('initialize');
  assert.notEqual((await fresh.rpc('read', 2)).result.pid, state.pid);
  assert.equal((await b.rpc('read', 3)).result.value, 0);
  // Exercise the actual stdio adapter, including its private handshake.
  const adapter = spawn(process.execPath, [path.join(__dirname, 'browser-client.cjs')], {
    env: {...process.env, AGENT_BROWSER_SOCKET: socketPath, AGENT_BROWSER_SESSION_KEY: 'adapter'},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => adapter.kill());
  const adapterLines = readline.createInterface({input: adapter.stdout});
  const initialized = once(adapterLines, 'line');
  adapter.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 7, method: 'initialize'}) + '\n');
  assert.equal(JSON.parse((await initialized)[0]).id, 7);
  const adapterExit = once(adapter, 'exit');
  adapter.stdin.end();
  assert.equal((await adapterExit)[0], 0);
});

test('real Playwright sessions isolate pages and cookies and retain disconnected context', {
  timeout: 90000, skip: !process.env.AGENT_BROWSER_REAL_MCP_CLI,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-real-'));
  const socketPath = path.join(dir, 'broker.sock');
  const child = spawn(process.execPath, [path.join(__dirname, 'browser-broker.cjs')], {env: {...process.env,
    AGENT_BROWSER_SOCKET: socketPath, AGENT_BROWSER_ARTIFACT_DIR: dir,
    AGENT_BROWSER_MCP_CLI: process.env.AGENT_BROWSER_REAL_MCP_CLI,
    AGENT_BROWSER_HEADLESS: '1', AGENT_BROWSER_GRACE_MS: '10000'}, stdio: ['ignore', 'ignore', 'inherit']});
  const clients = [];
  t.after(async () => {for (const c of clients) c.socket.destroy(); const exited = once(child, 'exit'); child.kill(); await exited; await fs.rm(dir, {recursive: true, force: true});});
  for (let i = 0; i < 100; i++) {
    try {await fs.stat(socketPath); break;} catch {await new Promise(r => setTimeout(r, 20));}
  }
  let id = 1;
  const attach = async key => {
    const c = await connect(socketPath, key); clients.push(c);
    assert.equal(c.attachment.attached, true);
    const initialized = await c.rpc('initialize', id++, {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'isolation-test', version: '1'}});
    assert.ok(initialized.result);
    c.notify('notifications/initialized');
    return c;
  };
  const a = await attach('a'); const b = await attach('b');
  const tools = (await a.rpc('tools/list', id++)).result.tools;
  const runCode = tools.find(t => /^browser_run_code/.test(t.name));
  assert.ok(runCode, 'Playwright code tool available for integration verification');
  const run = async (client, code) => {
    const response = await client.rpc('tools/call', id++, {name: runCode.name, arguments: {code}});
    assert.ok(response.result, JSON.stringify(response));
    assert.ok(!response.result.isError, JSON.stringify(response.result));
    return response.result.content.map(c => c.text || '').join('\n');
  };
  await Promise.all([
    run(a, "async page => { await page.context().addCookies([{name:'owner',value:'alpha',url:'https://example.com'}]); await page.setContent('<title>Alpha</title>'); return page.title(); }"),
    run(b, "async page => { await page.setContent('<title>Beta</title>'); return page.title(); }"),
  ]);
  assert.match(await run(a, "async page => JSON.stringify({title:await page.title(),cookies:await page.context().cookies()})"), /alpha/);
  const other = await run(b, "async page => JSON.stringify({title:await page.title(),cookies:await page.context().cookies()})");
  assert.match(other, /Beta/); assert.doesNotMatch(other, /alpha|Alpha/);
  a.socket.destroy(); await new Promise(r => setTimeout(r, 100));
  const again = await attach('a');
  assert.match(await run(again, "async page => page.title()"), /Alpha/);
  await again.rpc('tools/call', id++, {name: 'browser_close', arguments: {}});
  assert.match(await run(b, "async page => page.title()"), /Beta/);
});
