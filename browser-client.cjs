const net = require('node:net');
const {parseRecording} = require('./recording.cjs');
let recordVideo;
try {recordVideo = parseRecording(process.env.AGENT_BROWSER_RECORD_VIDEO);} catch (error) {
  console.error(error.message); process.exit(1);
}
const socket = net.connect(process.env.AGENT_BROWSER_SOCKET || '/tmp/agent-browser.sock');
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('connect', () => socket.write(JSON.stringify({sessionKey: process.env.AGENT_BROWSER_SESSION_KEY || '', recordVideo}) + '\n'));
let handshake = Buffer.alloc(0);
function attached(chunk) {
  handshake = Buffer.concat([handshake, chunk]);
  const end = handshake.indexOf(10);
  if (end < 0) return;
  const response = JSON.parse(handshake.subarray(0, end).toString());
  if (!response.attached) {
    console.error(response.error || 'Attach failed');
    process.exitCode = 1;
    socket.destroy();
    return;
  }
  if (response.recording) console.error('Browser video directory: ' + response.recording.directory);
  socket.removeListener('data', attached);
  if (end + 1 < handshake.length) process.stdout.write(handshake.subarray(end + 1));
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
}
socket.on('data', attached);
socket.on('close', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
