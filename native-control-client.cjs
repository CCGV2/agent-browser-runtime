const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {PORT, prepare, dataDir} = require('./native-control.cjs');

function request(dir, role, route, body, {port = Number(process.env.AGENT_BROWSER_CONTROL_PORT || PORT), timeout = 5000} = {}) {
  return new Promise((resolve, reject) => {
    let token;
    try {token = fs.readFileSync(path.join(dir, 'secrets', `control-${role}-token`), 'utf8').trim();} catch {return reject(Error('Browser control is not initialized'));}
    const req = http.request({host: '127.0.0.1', port, path: route, method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}}, res => {
      let text = '';
      res.on('data', chunk => {text += chunk; if (text.length > 1024 * 1024) req.destroy(Error('Control response too large'));});
      res.on('end', () => {try {const data = JSON.parse(text); if (res.statusCode !== 200) reject(Error(data.error || 'Control request failed')); else resolve(data);} catch {reject(Error('Invalid control response'));}});
    });
    req.setTimeout(timeout, () => req.destroy(Error('Browser control unavailable')));
    req.on('error', () => reject(Error('Browser control unavailable')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function ensureService(dir = dataDir()) {
  prepare(dir);
  try {await request(dir, 'runtime', '/runtime/policy?session=health'); return;} catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'native-control.cjs')], {
    env: {...process.env, AGENT_BROWSER_NATIVE_DATA_DIR: dir}, detached: true, stdio: 'ignore',
  });
  child.on('error', () => {}); child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {await request(dir, 'runtime', '/runtime/policy?session=health'); return;} catch {}
  }
  throw Error('Could not start browser control; check port availability');
}
module.exports = {request, ensureService};
