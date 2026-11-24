const readline = require('node:readline');
let initialized = false;
let value = 0, generation = 0;
process.on('message', message => {if (message.type === 'browser-activity') generation = message.generation;});
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') { initialized = true; return; }
  if (m.method === 'hang') return;
  if (m.method === 'simulate-idle') {process.send({type: 'browser-idle', generation}); return;}
  if (m.method === 'simulate-stale-idle') {process.send({type: 'browser-idle', generation: -1}); return;}
  const result = m.method === 'initialize' ? {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'fake', version: '1'}} : {pid: process.pid, initialized, value: m.method === 'increment' ? ++value : value};
  if (m.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: m.id, result}) + '\n');
});
