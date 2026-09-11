// Private, container-local protocol: one identity line, then newline JSON-RPC.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {SessionPool} = require('./session-pool.cjs');

process.umask(0o077);
const socketPath = process.env.AGENT_BROWSER_SOCKET || '/tmp/agent-browser.sock';
const grace = Number(process.env.AGENT_BROWSER_GRACE_MS || 300000);
if (!Number.isFinite(grace) || grace < 0) throw Error('Invalid grace period');
const pool = new SessionPool(key => {
  const directory = path.join(process.env.AGENT_BROWSER_ARTIFACT_DIR || '/data/artifacts', createHash('sha256').update(key).digest('hex'));
  fs.mkdirSync(directory, {recursive: true});
  const child = spawn(process.execPath, [
    process.env.AGENT_BROWSER_MCP_CLI || path.join(__dirname, 'docker-focus.cjs'),
    '--browser', 'chromium', '--sandbox', '--isolated',
    '--output-dir', directory, '--timeout-action', '10000',
    '--timeout-navigation', '90000', '--viewport-size', '1440x900',
    ...(process.env.AGENT_BROWSER_HEADLESS === '1' ? ['--headless'] : []),
    ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH ? ['--executable-path', process.env.AGENT_BROWSER_EXECUTABLE_PATH] : []),
  ], {stdio: ['pipe', 'pipe', 'inherit']});
  const worker = {
    child, socket: null, initialized: null, initializeID: undefined,
    pending: new Set(), workerRequests: new Set(), initializedNotification: false,
    close() { child.stdin.end(); child.kill('SIGTERM'); worker.socket?.destroy(); },
  };
  readline.createInterface({input: child.stdout}).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && !message.method) {
        worker.pending.delete(JSON.stringify(message.id));
        if (worker.initializeID !== undefined && message.id === worker.initializeID) {
          if (message.result) worker.initialized = message.result;
          worker.initializeID = undefined;
        }
      }
      if (message.method && message.id !== undefined) worker.workerRequests.add(JSON.stringify(message.id));
      worker.socket?.write(line + '\n');
    } catch { pool.remove(key, worker); }
  });
  child.on('exit', () => pool.remove(key, worker));
  child.on('error', () => pool.remove(key, worker));
  child.stdin.on('error', () => pool.remove(key, worker));
  return worker;
}, grace);

const server = net.createServer(socket => {
  let key, worker;
  const lines = readline.createInterface({input: socket, crlfDelay: Infinity});
  socket.on('error', () => {});
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (!worker) {
        key = message.sessionKey || randomUUID();
        if (typeof key !== 'string' || key.length > 1024) throw Error('Invalid session key');
        worker = pool.attach(key);
        worker.socket = socket;
        socket.write(JSON.stringify({attached: true}) + '\n');
        return;
      }
      if (message.method === 'initialize') {
        if (worker.initialized) {
          socket.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: worker.initialized}) + '\n');
          return;
        }
        worker.initializeID = message.id;
      }
      if (message.method === 'notifications/initialized') {
        if (worker.initializedNotification) return;
        worker.initializedNotification = true;
      }
      if (message.method && message.id !== undefined) worker.pending.add(JSON.stringify(message.id));
      if (!message.method && message.id !== undefined) worker.workerRequests.delete(JSON.stringify(message.id));
      worker.child.stdin.write(line + '\n');
    } catch (error) {
      socket.end(JSON.stringify({error: error.message}) + '\n');
    }
  });
  socket.on('close', () => {
    if (!worker) return;
    worker.socket = null;
    // Never replay a possibly completed click after disconnect.
    if (worker.pending.size || worker.workerRequests.size || !worker.initialized) pool.remove(key, worker);
    else pool.detach(key, worker);
  });
});
server.listen(socketPath);
function shutdown() { pool.close(); server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
