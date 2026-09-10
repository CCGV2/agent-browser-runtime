// Single writer for native-browser policy, approvals and audit. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = 7331;
const random = () => crypto.randomBytes(32).toString('hex');
function atomic(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, value, {mode: 0o600, flag: 'wx'}); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function dataDir() {
  if (process.env.AGENT_BROWSER_NATIVE_DATA_DIR) return path.resolve(process.env.AGENT_BROWSER_NATIVE_DATA_DIR);
  const config = process.env.AGENT_BROWSER_NATIVE_CONFIG_DIR || (fs.existsSync(path.join(__dirname, 'data-dir')) ? __dirname : path.join(process.env.XDG_CONFIG_HOME || path.join(require('node:os').homedir(), '.config'), 'agent-browser-native'));
  return fs.readFileSync(path.join(config, 'data-dir'), 'utf8').trim();
}
function normalizeOrigin(value, port = PORT) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid origin');
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('Enter an exact http(s) origin without path, credentials, query or fragment');
  // The control plane is never an agent-accessible site, even if allowlisted.
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port) throw Error('The management origin cannot be granted');
  return u.origin;
}
function prepare(dir) {
  for (const sub of ['control', 'secrets']) fs.mkdirSync(path.join(dir, sub), {recursive: true, mode: 0o700});
  for (const name of ['control-admin-token', 'control-runtime-token']) {
    try { fs.writeFileSync(path.join(dir, 'secrets', name), random(), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const policy = path.join(dir, 'control', 'policy.json');
  try { fs.writeFileSync(policy, JSON.stringify({version: 1, origins: [], paused: false}), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
class ControlStore {
  constructor(dir, {port = PORT, now = Date.now} = {}) {
    prepare(dir); this.dir = dir; this.port = port; this.now = now;
    this.pending = new Map(); this.grants = new Map(); this.loginCodes = new Map(); this.adminSessions = new Map();
    this.policyFile = path.join(dir, 'control', 'policy.json');
    // Corrupt policy must stop startup, never fall back to allow-all.
    this.policy = JSON.parse(fs.readFileSync(this.policyFile, 'utf8'));
    if (this.policy.version !== 1 || !Array.isArray(this.policy.origins) || typeof this.policy.paused !== 'boolean') throw Error('Invalid policy');
    this.policy.origins = this.policy.origins.map(o => normalizeOrigin(o, port));
    this.auditFile = path.join(dir, 'control', 'audit.jsonl');
    this.audit('service.started');
  }
  audit(event, fields = {}) {
    // Explicit schema: never log input text, screenshots, page titles, tokens or URL paths.
    const row = {at: new Date(this.now()).toISOString(), event};
    for (const key of ['session', 'requestId', 'approvalId', 'tool', 'origin', 'decision', 'outcome', 'durationMs', 'revision', 'scope']) {
      if (typeof fields[key] === 'string') row[key] = fields[key].slice(0, 256);
      else if (typeof fields[key] === 'number' && Number.isFinite(fields[key])) row[key] = fields[key];
    }
    const fd = fs.openSync(this.auditFile, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  sweep() {
    const now = this.now();
    for (const [id, p] of this.pending) if (p.expires <= now) this.pending.delete(id);
    for (const [key, expiry] of this.grants) if (expiry <= now) this.grants.delete(key);
    for (const map of [this.loginCodes, this.adminSessions]) for (const [key, expiry] of map) if (expiry <= now) map.delete(key);
  }
  policyFor(session) {
    this.sweep();
    return {revision: this.policy.revision || 0, paused: this.policy.paused,
      origins: this.policy.paused ? [] : [...new Set([...this.policy.origins, ...[...this.grants.keys()].filter(k => k.startsWith(session + '\n')).map(k => k.split('\n')[1])])]};
  }
  changePolicy(origins, paused) {
    if (!Array.isArray(origins) || origins.length > 200 || typeof paused !== 'boolean') throw Error('Invalid policy');
    const next = {version: 1, revision: (this.policy.revision || 0) + 1, paused, origins: [...new Set(origins.map(o => normalizeOrigin(o, this.port)))]};
    this.audit('policy.changed', {revision: next.revision});
    for (const origin of this.policy.origins.filter(o => !next.origins.includes(o))) this.audit('origin.revoked', {origin});
    for (const origin of next.origins.filter(o => !this.policy.origins.includes(o))) this.audit('origin.granted', {origin, scope: 'global'});
    atomic(this.policyFile, JSON.stringify(next, null, 2) + '\n');
    this.policy = next;
    // Any policy edit invalidates temporary grants: removal must not leave an old session grant alive.
    this.grants.clear();
    if (paused) for (const p of this.pending.values()) if (p.decision === 'pending') p.decision = 'deny';
    return this.policy;
  }
  request({session, origin, tool, requestId}) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session || '') || !/^browser_[a-z_]{1,60}$/.test(tool || '')) throw Error('Invalid request');
    origin = normalizeOrigin(origin, this.port); this.sweep();
    if (requestId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw Error('Invalid request ID');
    for (const p of this.pending.values()) if (p.session === session && p.origin === origin && p.decision === 'pending') {
      if (requestId && requestId !== p.requestId) this.audit('approval.joined', {session, origin, tool, requestId, approvalId: p.id});
      return p;
    }
    if (this.pending.size >= 500) throw Error('Too many pending requests');
    const p = {id: crypto.randomUUID(), requestId, session, origin, tool, decision: 'pending', expires: this.now() + 5 * 60_000};
    this.audit('approval.requested', {...p, requestId: requestId || p.id, approvalId: p.id}); this.pending.set(p.id, p); return p;
  }
  decide(id, decision, scope) {
    this.sweep(); const p = this.pending.get(id);
    if (!p || p.decision !== 'pending') throw Error('Request expired or already decided');
    if (!['allow', 'deny'].includes(decision) || !['session', 'global'].includes(scope)) throw Error('Invalid decision');
    if (decision === 'allow' && this.policy.paused) throw Error('Resume browser control before granting access');
    this.audit('approval.decided', {...p, requestId: p.requestId || id, approvalId: id, decision, scope});
    if (decision === 'allow') {
      if (scope === 'global') this.changePolicy([...this.policy.origins, p.origin], false);
      else this.grants.set(p.session + '\n' + p.origin, this.now() + 30 * 60_000);
    }
    p.decision = decision; this.pending.set(id, p); return p;
  }
  auditTail() {
    // Bounded read of the end of the log; no growing whole-file reads.
    const fd = fs.openSync(this.auditFile, 'r');
    try {
      const size = fs.fstatSync(fd).size; const offset = Math.max(0, size - 256 * 1024); const b = Buffer.alloc(size - offset);
      fs.readSync(fd, b, 0, b.length, offset);
      const lines = b.toString('utf8').split('\n'); if (offset) lines.shift();
      return lines.filter(Boolean).slice(-200).map(line => { try { return JSON.parse(line); } catch { return {event: 'unreadable-record'}; } }).reverse();
    } finally { fs.closeSync(fd); }
  }
}
function equal(a, b) {
  return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function readBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Error('JSON required');
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 16 * 1024) throw Error('Request too large'); }
  return JSON.parse(text || '{}');
}
function createControlServer(store) {
  const secret = n => fs.readFileSync(path.join(store.dir, 'secrets', n), 'utf8').trim();
  const adminToken = secret('control-admin-token'); const runtimeToken = secret('control-runtime-token');
  const loginAttempts = {at: 0, count: 0};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (code, body) => {res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body));};
    try {
      const hosts = [`127.0.0.1:${store.port}`, `localhost:${store.port}`];
      if (!hosts.includes(req.headers.host)) return reply(403, {error: 'Host denied'});
      const expectedOrigin = 'http://' + req.headers.host;
      if (req.headers.origin && req.headers.origin !== expectedOrigin) return reply(403, {error: 'Origin denied'});
      const url = new URL(req.url, expectedOrigin); const route = url.pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(route)) {
        const name = route === '/' ? 'index.html' : route.slice(1);
        res.writeHead(200, {'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'});
        return res.end(fs.readFileSync(path.join(__dirname, 'control-ui', name)));
      }
      if (route === '/health' && req.method === 'GET') return reply(200, {service: 'agent-browser-control', version: 1});
      store.sweep();
      if (route === '/login' && req.method === 'POST') {
        if (store.now() - loginAttempts.at > 60_000) {loginAttempts.at = store.now(); loginAttempts.count = 0;}
        if (++loginAttempts.count > 10) return reply(429, {error: 'Try again in one minute'});
        const body = await readBody(req); const code = String(body.code || '').trim();
        if (!store.loginCodes.has(code)) return reply(401, {error: 'Invalid or expired login code'});
        store.loginCodes.delete(code); const token = random(); store.adminSessions.set(token, store.now() + 8 * 60 * 60_000);
        store.audit('admin.login'); return reply(200, {token});
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const admin = equal(token, adminToken) || store.adminSessions.has(token);
      const runtime = equal(token, runtimeToken);
      if (route.startsWith('/admin/') && !admin || route.startsWith('/runtime/') && !runtime) return reply(401, {error: 'Unauthorized'});
      if (route === '/admin/login-code' && req.method === 'POST') {
        const code = crypto.randomBytes(6).toString('hex'); store.loginCodes.set(code, store.now() + 10 * 60_000); return reply(200, {code});
      }
      if (route === '/admin/logout' && req.method === 'POST') {store.adminSessions.delete(token); return reply(200, {ok: true});}
      if (route === '/admin/shutdown' && req.method === 'POST') {store.audit('service.stopped'); reply(200, {ok: true}); server.close(); return;}
      if (route === '/admin/state' && req.method === 'GET') return reply(200, {policy: store.policy, pending: [...store.pending.values()], audit: store.auditTail(), paired: fs.existsSync(path.join(store.dir, 'secrets', 'extension-token')), grants: [...store.grants].map(([key, expires]) => ({session: key.split('\n')[0], origin: key.split('\n')[1], expires}))});
      if (route === '/admin/policy' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.revision !== (store.policy.revision || 0)) return reply(409, {error: 'Policy changed elsewhere. Refresh and retry.'});
        return reply(200, store.changePolicy(b.origins, b.paused));
      }
      if (route === '/admin/revoke' && req.method === 'POST') {
        const b = await readBody(req); const origin = normalizeOrigin(b.origin, store.port);
        store.audit('grant.revoked', {session: b.session, origin, scope: 'session'});
        store.grants.delete(b.session + '\n' + origin); return reply(200, {ok: true});
      }
      if (route === '/admin/decide' && req.method === 'POST') {const b = await readBody(req); return reply(200, store.decide(b.id, b.decision, b.scope));}
      if (route === '/admin/pair' && req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(b.token)) throw Error('Invalid extension token');
        store.audit('extension.paired'); atomic(path.join(store.dir, 'secrets', 'extension-token'), b.token); return reply(200, {paired: true, reconnectRequired: true});
      }
      if (route === '/runtime/policy' && req.method === 'GET') return reply(200, store.policyFor(url.searchParams.get('session') || ''));
      if (route === '/runtime/request' && req.method === 'POST') return reply(200, store.request(await readBody(req)));
      if (route === '/runtime/decision' && req.method === 'GET') {
        const p = store.pending.get(url.searchParams.get('id')); return reply(200, {decision: p?.session === url.searchParams.get('session') ? p.decision : 'expired'});
      }
      if (route === '/runtime/audit' && req.method === 'POST') {
        const b = await readBody(req); if (!['tool.started', 'tool.finished', 'navigation.blocked', 'download.cancelled'].includes(b.event)) throw Error('Invalid event');
        store.audit(b.event, b); return reply(200, {ok: true});
      }
      reply(404, {error: 'Not found'});
    } catch (error) { if (!res.headersSent) reply(400, {error: ['ENOSPC','EACCES','EIO'].includes(error.code) ? 'Control storage unavailable' : error.message}); else res.end(); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return server;
}
module.exports = {PORT, dataDir, prepare, normalizeOrigin, ControlStore, createControlServer};
if (require.main === module) {
  process.umask(0o077);
  const store = new ControlStore(dataDir(), {port: Number(process.env.AGENT_BROWSER_CONTROL_PORT || PORT)});
  const server = createControlServer(store);
  server.on('error', () => {console.error('Browser control could not start; check the configured port.'); process.exit(1);});
  server.listen(store.port, '127.0.0.1');
  for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
