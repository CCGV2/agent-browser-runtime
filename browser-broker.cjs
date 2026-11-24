// Private, container-local protocol: one identity line, then newline JSON-RPC.
const net = require('node:net');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {SessionPool} = require('./session-pool.cjs');
const {prepareRecording} = require('./recording.cjs');
const {stopWorker} = require('./worker-stop.cjs');

process.umask(0o077);
const socketPath = process.env.AGENT_BROWSER_SOCKET || '/tmp/agent-browser.sock';
const stopping = new Set();
const pool = new SessionPool((key, options) => {
  const baseDirectory = path.join(process.env.AGENT_BROWSER_ARTIFACT_DIR || '/data/artifacts', createHash('sha256').update(key).digest('hex'));
  const recording = prepareRecording(baseDirectory, options.recordVideo);
  const {directory} = recording;
  const child = spawn(process.execPath, [
    process.env.AGENT_BROWSER_MCP_CLI || path.join(__dirname, 'docker-focus.cjs'),
    '--browser', 'chromium', '--sandbox', '--isolated',
    '--output-dir', directory, '--timeout-action', '10000',
    '--timeout-navigation', '90000', '--viewport-size', '1440x900',
    ...(recording.configPath ? ['--config', recording.configPath] : []),
    ...(process.env.AGENT_BROWSER_HEADLESS === '1' ? ['--headless'] : []),
    ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH ? ['--executable-path', process.env.AGENT_BROWSER_EXECUTABLE_PATH] : []),
  ], {stdio: ['pipe', 'pipe', 'inherit', 'ipc']});
  const worker = {
    child, socket: null, initialized: null, initializeID: undefined, activityGeneration: 0,
    pending: new Set(), workerRequests: new Set(), recordingCloseIDs: new Set(), initializedNotification: false,
    recording,
    close() {
      worker.socket?.destroy();
      if (!worker.stopped) {
        worker.stopped = stopWorker(child, 20000, recording.videoDirectory && worker.initialized ? () => new Promise(resolve => {
          worker.finalizeID = 'broker-close-' + randomUUID();
          worker.finalizeRecording = resolve;
          child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: worker.finalizeID, method: 'tools/call',
            params: {name: 'browser_close', arguments: {}}}) + '\n');
        }) : undefined);
        stopping.add(worker.stopped);
        worker.stopped.then(() => stopping.delete(worker.stopped));
      }
      return worker.stopped;
    },
  };
  readline.createInterface({input: child.stdout}).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (!message.method && message.id === worker.finalizeID && worker.finalizeRecording) {
        if (message.error || message.result?.isError) console.error('Browser recording finalization failed');
        worker.finalizeRecording();
        return;
      }
      if (message.id !== undefined && !message.method) {
        worker.pending.delete(JSON.stringify(message.id));
        if (worker.recordingCloseIDs.delete(JSON.stringify(message.id)) && message.result && !message.result.isError) {
          message.result.content = [...(message.result.content || []), {
            type: 'text', text: 'Video directory: ' + recording.videoDirectory + ' (one WebM per page; recording files are finalized after browser_close).',
          }];
          line = JSON.stringify(message);
        }
        if (worker.initializeID !== undefined && message.id === worker.initializeID) {
          if (message.result) worker.initialized = message.result;
          worker.initializeID = undefined;
        }
      }
      if (message.method && message.id !== undefined) worker.workerRequests.add(JSON.stringify(message.id));
      worker.socket?.write(line + '\n');
    } catch { pool.remove(key, worker); }
  });
  child.on('message', message => {
    if (message?.type !== 'browser-idle') return;
    if (message.generation !== worker.activityGeneration || worker.pending.size || worker.workerRequests.size) {
      child.send({type: 'browser-activity', generation: worker.activityGeneration}, () => {});
      return;
    }
    pool.remove(key, worker);
  });
  child.on('exit', () => pool.remove(key, worker));
  child.on('error', () => pool.remove(key, worker));
  child.stdin.on('error', () => pool.remove(key, worker));
  return worker;
}, null);

const connections = new Set();
const server = net.createServer(socket => {
  connections.add(socket);
  let key, worker;
  const lines = readline.createInterface({input: socket, crlfDelay: Infinity});
  socket.on('error', () => {});
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (!worker) {
        key = message.sessionKey || randomUUID();
        if (typeof key !== 'string' || key.length > 1024) throw Error('Invalid session key');
        if (message.recordVideo !== undefined && typeof message.recordVideo !== 'boolean') throw Error('recordVideo must be a boolean');
        worker = pool.attach(key, {recordVideo: message.recordVideo === true});
        worker.socket = socket;
        socket.write(JSON.stringify({attached: true, ...(worker.recording.videoDirectory ? {recording: {directory: worker.recording.videoDirectory}} : {})}) + '\n');
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
      if (message.method === 'tools/call') {
        worker.activityGeneration++;
        worker.child.send({type: 'browser-activity', generation: worker.activityGeneration}, () => {});
        if (worker.recording.videoDirectory && message.params?.name === 'browser_close' && message.id !== undefined)
          worker.recordingCloseIDs.add(JSON.stringify(message.id));
      }
      if (message.method && message.id !== undefined) worker.pending.add(JSON.stringify(message.id));
      if (!message.method && message.id !== undefined) worker.workerRequests.delete(JSON.stringify(message.id));
      worker.child.stdin.write(line + '\n');
    } catch (error) {
      socket.end(JSON.stringify({error: error.message}) + '\n');
    }
  });
  socket.on('close', () => {
    connections.delete(socket);
    if (!worker) return;
    worker.socket = null;
    // Never replay a possibly completed click after disconnect.
    if (worker.pending.size || worker.workerRequests.size || !worker.initialized) pool.remove(key, worker);
    else pool.detach(key, worker);
  });
});
server.listen(socketPath);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise(resolve => server.close(resolve));
  const workersClosed = pool.close();
  for (const socket of connections) socket.destroy();
  await workersClosed;
  await Promise.all([...stopping]);
  await closed;
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
