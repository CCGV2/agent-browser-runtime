#!/usr/bin/env node
const {spawn} = require('node:child_process');
const {dataDir, PORT} = require('./native-control.cjs');
const {ensureService, request} = require('./native-control-client.cjs');
async function main() {
  const dir = dataDir(); await ensureService(dir);
  const command = process.argv[2] || 'open';
  const port = Number(process.env.AGENT_BROWSER_CONTROL_PORT || PORT);
  if (command === 'start') {console.log(`Browser control is running at http://127.0.0.1:${port}`); return;}
  if (command === 'stop') {await request(dir, 'admin', '/admin/shutdown', {}); console.log('Browser control stopped.'); return;}
  if (!['open', 'login'].includes(command)) throw Error('Usage: node native-control-cli.cjs [start|stop|open|login]');
  const {code} = await request(dir, 'admin', '/admin/login-code', {});
  if (command === 'login') {
    // Operator-only command. Never invoke this on behalf of a browser agent.
    console.log(`Open http://127.0.0.1:${port} and enter this one-time code (10 minutes): ${code}`);
    console.log(`For remote access: ssh -N -L ${port}:127.0.0.1:${port} USER@HOST`);
  } else {
    const url = `http://127.0.0.1:${port}/#code=${code}`;
    if (process.platform !== 'darwin') throw Error('Use the login command and open the management page manually');
    const child = spawn('/usr/bin/open', [url], {stdio: 'ignore'});
    await new Promise((resolve, reject) => {child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error('Could not open browser')));});
    console.log('Opened browser control. The login code is not saved in the URL after login.');
  }
}
main().catch(e => {console.error(e.message); process.exitCode = 1;});
