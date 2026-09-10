const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {ControlStore, normalizeOrigin, createControlServer} = require('./native-control.cjs');

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-control-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return new ControlStore(dir, options);
}
test('origins are exact, normalized and cannot grant management or URL credentials', () => {
  assert.equal(normalizeOrigin('https://GitHub.com:443'), 'https://github.com');
  for (const value of ['https://github.com/path','https://other.test/?github.com','https://github.com@other.test','file:///tmp/a','*','http://127.0.0.1:7331','http://localhost:7331']) assert.throws(() => normalizeOrigin(value));
});
test('empty deny, persistent global policy, expiring scoped grants and revocation', t => {
  let now = 1000; const s = fixture(t, {now: () => now});
  assert.deepEqual(s.policyFor('alpha').origins, []);
  const p = s.request({session:'alpha',tool:'browser_navigate',origin:'https://github.com'});
  s.decide(p.id,'allow','session');
  assert.deepEqual(s.policyFor('alpha').origins, ['https://github.com']);
  assert.deepEqual(s.policyFor('beta').origins, []);
  now += 31 * 60_000; assert.deepEqual(s.policyFor('alpha').origins, []);
  s.changePolicy(['https://github.com'],false);
  assert.deepEqual(new ControlStore(s.dir).policyFor('beta').origins, ['https://github.com']);
  const temp = s.request({session:'alpha',tool:'browser_navigate',origin:'https://other.test'}); s.decide(temp.id,'allow','session');
  s.changePolicy([],false); assert.deepEqual(s.policyFor('alpha').origins, []);
  s.changePolicy(['https://github.com'],true); assert.deepEqual(s.policyFor('alpha').origins, []);
});
test('audit contains only whitelisted metadata, and corrupted policy fails closed', t => {
  const s = fixture(t);
  s.audit('tool.started', {tool:'browser_type',session:'alpha',text:'PASSWORD_SENTINEL',token:'TOKEN_SENTINEL',url:'https://example.com/?secret=SENTINEL'});
  assert.doesNotMatch(fs.readFileSync(s.auditFile,'utf8'), /SENTINEL/);
  fs.writeFileSync(s.policyFile,'{'); assert.throws(() => new ControlStore(s.dir));
  assert.equal(fs.statSync(s.auditFile).mode & 0o777, 0o600);
});
function send(port, route, token, body, headers = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port,path:route,method:body === undefined ? 'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers}}, res => {
      let text=''; res.on('data',c=>text+=c); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('HTTP separates runtime/admin, rejects cross-origin and replays, and pairing never reveals token', async t => {
  const s = fixture(t); const server = createControlServer(s);
  await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);}); s.port = server.address().port;
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const secret = name => fs.readFileSync(path.join(s.dir,'secrets',`control-${name}-token`),'utf8');
  const admin=secret('admin'), runtime=secret('runtime');
  assert.equal((await send(s.port,'/admin/policy',runtime,{origins:['https://github.com'],paused:false})).status,401);
  assert.equal((await send(s.port,'/runtime/policy?session=x',admin)).status,401);
  assert.equal((await send(s.port,'/admin/state',admin,undefined,{Origin:'https://evil.test'})).status,403);
  assert.equal((await send(s.port,'/admin/state',admin,undefined,{Host:'evil.test'})).status,403);
  assert.equal((await send(s.port,'/admin/policy',admin,{revision:0,origins:['https://github.com'],paused:false})).status,200);
  assert.equal((await send(s.port,'/admin/policy',admin,{revision:0,origins:[],paused:false})).status,409);
  const temporary=s.request({session:'alpha',tool:'browser_snapshot',origin:'https://other.test'});s.decide(temporary.id,'allow','session');
  assert.equal((await send(s.port,'/admin/revoke',admin,{session:'alpha',origin:'https://other.test'})).status,200);
  assert.ok(!s.policyFor('alpha').origins.includes('https://other.test'));
  const code=(await send(s.port,'/admin/login-code',admin,{})).body.code;
  const login=await send(s.port,'/login','',{code}); assert.equal(login.status,200);
  assert.equal((await send(s.port,'/login','',{code})).status,401);
  const pair='EXTENSION_TEST_SECRET_0123456789';
  assert.equal((await send(s.port,'/admin/pair',login.body.token,{token:pair})).status,200);
  const state=await send(s.port,'/admin/state',login.body.token);
  assert.equal(state.body.paired,true); assert.doesNotMatch(JSON.stringify(state.body),/EXTENSION_TEST_SECRET/);
  assert.equal((await send(s.port,'/admin/logout',login.body.token,{})).status,200);
  assert.equal((await send(s.port,'/admin/state',login.body.token)).status,401);
});
