// Opt-in real browser verification: a fresh profile and local fixture sites only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const readline = require('node:readline');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {ControlStore, createControlServer} = require('./native-control.cjs');

async function listen(server) {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); return server.address().port;}
async function until(fn, timeout = 30_000) {const end=Date.now()+timeout; while(Date.now()<end){const r=fn();if(r)return r;await new Promise(r=>setTimeout(r,50));} throw Error('Condition timed out');}
test('real MCP: approval, page origins, embedded content, no replay, revocation and auditing', {timeout:150_000,skip:!process.env.AGENT_BROWSER_TEST_EXECUTABLE}, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-browser-e2e-'));
  let privateReads=0; let blockedTopReads=0;
  const canary = crypto.randomBytes(32).toString('hex'); let passwordMatched = false;
  const privateSite=http.createServer((req,res)=>{privateReads++;if(req.url === '/blocked-top') blockedTopReads++;res.end('<h1>PRIVATE_PAGE_SENTINEL</h1>');});
  const privatePort=await listen(privateSite); const privateOrigin=`http://127.0.0.1:${privatePort}`;
  const site=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    if(req.url==='/check' && req.method === 'POST') {let body=''; req.on('data', d => body += d); req.on('end', () => {passwordMatched = body === canary; body=''; res.end('ok');}); return;}
    if(req.url==='/iframe') return res.end(`<h1>Allowed frame host</h1><iframe src="${privateOrigin}/"></iframe>`);
    if(req.url==='/redirect'){res.writeHead(302,{Location:privateOrigin+'/blocked-top'});return res.end();}
    res.end(`<h1>Allowed fixture</h1><input id="password" type="password" oninput="fetch('/check', {method:'POST',body:this.value})"><button id="count" onclick="this.textContent='Clicked once'">Count</button><a id="leave" href="${privateOrigin}/blocked-top">Leave</a>`);
  });
  const sitePort=await listen(site); const origin=`http://127.0.0.1:${sitePort}`;
  const store=new ControlStore(dir); const control=createControlServer(store); store.port=await listen(control);
  const operator = await require('playwright').chromium.launch({headless:true, chromiumSandbox:true, executablePath:process.env.AGENT_BROWSER_TEST_EXECUTABLE});
  const operatorPage = await operator.newPage();
  store.loginCodes.set('fixture-operator-code',Date.now()+60_000);
  await operatorPage.goto(`http://127.0.0.1:${store.port}/#code=fixture-operator-code`);
  await operatorPage.locator('#dashboard').waitFor({state:'visible'});
  const child=spawn(process.execPath,[path.join(__dirname,'native-worker.cjs')],{env:{...process.env,AGENT_BROWSER_NATIVE_DATA_DIR:dir,AGENT_BROWSER_CONTROL_PORT:String(store.port)},stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  t.after(async()=>{
    child.stdin.end();child.kill('SIGTERM');
    await operator.close();
    await Promise.all([control,site,privateSite].map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  let nextID=1; const pending=new Map();
  readline.createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;} if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=nextID++;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout: '+stderr.slice(-2000)));},100_000);pending.set(id,m=>{clearTimeout(timer);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  const call=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});assert.ok(r.result,JSON.stringify(r));return r.result;};
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'native-mvp-test',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=(await rpc('tools/list',{})).result.tools;
  assert.ok(tools.some(t=>t.name==='browser_snapshot'));
  assert.ok(!tools.some(t=>t.name==='browser_evaluate'));
  const navigation=call('browser_navigate',{url:origin});
  const approval=await until(()=>[...store.pending.values()].find(p=>p.origin===origin));
  assert.equal(approval.decision,'pending');
  await operatorPage.getByRole('button',{name:'始终允许',exact:true}).click();
  const artifactText = () => {
    const read = p => fs.readdirSync(p,{withFileTypes:true}).map(e=>e.isDirectory()?read(path.join(p,e.name)):e.name.endsWith('.yml')?fs.readFileSync(path.join(p,e.name),'utf8'):'').join('\n');
    return read(path.join(dir,'artifacts'));
  };
  const result=await navigation; assert.ok(!result.isError,JSON.stringify(result));assert.match(artifactText(),/Allowed fixture/);
  const clicked=await call('browser_click',{target:'#count'});assert.ok(!clicked.isError,JSON.stringify(clicked));assert.match(artifactText(),/Clicked once/);
  const screenshot=await call('browser_take_screenshot',{});assert.ok(!screenshot.isError,JSON.stringify(screenshot));
  assert.equal((await call('browser_evaluate',{expression:'document.title'})).isError,true);
  const before=privateReads;
  const leave=await call('browser_click',{target:'#leave'});
  assert.equal(leave.isError,true);assert.doesNotMatch(JSON.stringify(leave),/PRIVATE_PAGE_SENTINEL/);assert.equal(privateReads,before);assert.equal(blockedTopReads,0);
  const snap=await call('browser_snapshot');assert.doesNotMatch(JSON.stringify(snap),/PRIVATE_PAGE_SENTINEL/);
  const iframe=await call('browser_navigate',{url:origin+'/iframe'});assert.ok(!iframe.isError,JSON.stringify(iframe));
  assert.match(artifactText(),/PRIVATE_PAGE_SENTINEL/);
  assert.ok(privateReads > before);

  const redirect=await call('browser_navigate',{url:origin+'/redirect'});assert.equal(redirect.isError,true);assert.doesNotMatch(JSON.stringify(redirect),/PRIVATE_PAGE_SENTINEL/);
  // Redirect responses can reach Chromium before interception; their content must stay hidden.
  // Direct authorized navigation can recover a tab stranded outside the allowlist.
  assert.ok(!(await call('browser_navigate',{url:origin})).isError);
  assert.ok(tools.some(t => t.name === 'browser_fill_secret'));
  const liveSession = store.auditTail().find(e => e.event === 'tool.started').session;
  await until(() => store.viewer.workers.has(liveSession));
  const preview = await store.viewer.request({session:liveSession,action:{type:'screenshot'}});
  assert.ok(preview.image, JSON.stringify(preview));
  assert.equal(preview.frame, '');
  assert.equal(store.viewer.owner, null);
  assert.ok(!(await call('browser_snapshot')).isError);
  for (let i = 0; i < 3; i++) {
    assert.ok(!(await call('browser_snapshot')).isError);
    const next = await store.viewer.request({session:liveSession,action:{type:'screenshot'}});
    assert.ok(next.image, JSON.stringify(next));
    assert.equal(next.frame, '');
    assert.equal(store.viewer.owner, null);
  }
  await assert.rejects(store.viewer.request({session:liveSession,action:{type:'key',key:'Tab',frame:preview.frame}}), /Take control/);
  await store.viewer.request({session:liveSession,action:{type:'takeover'}});
  assert.equal((await call('browser_snapshot')).isError,true);
  const remoteFrame = await store.viewer.request({session:liveSession,action:{type:'screenshot'}});
  assert.ok(remoteFrame.image && remoteFrame.frame, JSON.stringify(remoteFrame));
  const remoteInput = await store.viewer.request({session:liveSession,action:{type:'key',key:'Tab',frame:remoteFrame.frame}});
  assert.equal(remoteInput.ok,true,JSON.stringify(remoteInput));
  const staleInput = await store.viewer.request({session:liveSession,action:{type:'key',key:'Tab',frame:remoteFrame.frame}});
  assert.ok(staleInput.error);
  await store.viewer.request({session:liveSession,action:{type:'release'}});
  store.secrets.root = fs.realpathSync(dir);
  const file = path.join(store.secrets.root, crypto.randomBytes(16).toString('hex'));
  fs.writeFileSync(file, canary, {mode:0o600});
  const session = store.auditTail().find(e => e.event === 'tool.started').session;
  const grant = store.secrets.register({fileRef:'file:'+file, session, origin, target:'#password'});
  const filled = await call('browser_fill_secret', {secret_ref:grant.secret_ref, origin, target:'#password'});
  assert.ok(!filled.isError, JSON.stringify(filled));
  await until(() => passwordMatched);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(store.secrets.dir), []);
  assert.equal(JSON.stringify(filled).includes(canary), false);
  const held = await call('browser_snapshot'); assert.equal(held.isError, true);
  assert.match(JSON.stringify(held), /SENSITIVE_SESSION_HELD/);
  assert.equal(artifactText().includes(canary), false);
  assert.equal(stderr.includes(canary), false);
  assert.equal(fs.readFileSync(store.auditFile, 'utf8').includes(canary), false);
  await operatorPage.getByRole('button', {name:'确认并恢复', exact:true}).click();
  assert.equal(store.secrets.holds.size, 0);
  const replay = await call('browser_fill_secret', {secret_ref:grant.secret_ref, origin, target:'#password'});
  assert.equal(replay.isError, true);
  store.changePolicy([],false);
  const revoked=call('browser_snapshot');
  const denied=await until(()=>[...store.pending.values()].find(p=>p.origin===origin&&p.decision==='pending'));store.decide(denied.id,'deny','session');
  assert.equal((await revoked).isError,true);
  const audit=store.auditTail();assert.ok(audit.some(e=>e.event==='approval.decided'));assert.ok(audit.some(e=>e.event==='tool.finished'&&e.outcome==='success'));assert.doesNotMatch(fs.readFileSync(store.auditFile,'utf8'),/PRIVATE_PAGE_SENTINEL|Clicked once/);
  assert.equal((await call('browser_navigate',{url:`http://127.0.0.1:${store.port}`})).isError,true);
  if (process.env.AGENT_BROWSER_UI_SCREENSHOT) await operatorPage.screenshot({path:process.env.AGENT_BROWSER_UI_SCREENSHOT,fullPage:true});
});
