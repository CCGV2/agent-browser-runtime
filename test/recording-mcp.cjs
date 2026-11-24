const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// A small MCP worker that exposes its launch configuration and needs time to
// flush artifacts. It deliberately stays alive after browser_close, like MCP.
const argv = process.argv.slice(2);
const option = name => {const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1];};
const outputDir = option('--output-dir');
const configPath = option('--config');
const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
let initialized = false;
let generation = 0;
let closing = false;

function close(reason) {
  if (closing) return;
  closing = true;
  setTimeout(() => {
    fs.mkdirSync(outputDir, {recursive: true});
    fs.writeFileSync(path.join(outputDir, 'worker-flushed.json'), JSON.stringify({pid: process.pid, reason}));
    process.exit(0);
  }, 180);
}

process.on('SIGTERM', () => close('SIGTERM'));
process.on('SIGINT', () => close('SIGINT'));
process.stdin.on('end', () => close('stdin'));
process.on('message', message => {
  if (message?.type === 'browser-activity') generation = message.generation;
});

readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') {initialized = true; return;}
  if (message.method === 'simulate-idle') {
    process.send?.({type: 'browser-idle', generation});
    return;
  }
  if (message.method === 'crash') process.exit(7);
  if (message.method === 'hang') return;
  let result;
  if (message.method === 'initialize') {
    result = {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'recording-fixture', version: '1'}};
  } else if (message.method === 'tools/call' && message.params?.name === 'browser_close') {
    result = {content: [{type: 'text', text: 'Closed browser.'}]};
  } else {
    result = {pid: process.pid, initialized, argv, outputDir, configPath, config};
  }
  if (message.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\n');
});
