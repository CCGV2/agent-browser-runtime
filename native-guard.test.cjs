const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const {NativeGuard, TOOLS} = require('./native-guard.cjs');
const {transform} = require('./native-playwright-hook.cjs');

function harness({origins = [], approve = true} = {}) {
  const policy = {origins,paused:false}; const events=[]; let invoked=0; let requested=0;
  const page=new EventEmitter(); page.url=()=>page.currentURL; page.currentURL='https://allowed.test'; page.isClosed=()=>false;
  const frame={url:()=>page.currentURL,parentFrame:()=>null}; page.frames=()=>[frame]; page.mainFrame=()=>frame;
  const tab={page,isCurrentTab:()=>true};
  const raw={route:async (_pattern,fn)=>{raw.handler=fn;}};
  const context={ensureBrowserContext:async()=>raw,ensureTab:async()=>tab,tabs:()=>[tab]};
  const backend={_context:context,_unguardedCallTool:async()=>{invoked++; return {content:[{type:'text',text:'allowed result'}]};}};
  const guard = new NativeGuard({session:'unit-session',timeout:1000,call:async(route,body)=>{
    if(route.startsWith('/runtime/policy')) return {...policy,origins:[...policy.origins]};
    if(route==='/runtime/request'){requested++; if(approve) policy.origins.push(body.origin); return {id:'request'};}
    if(route.startsWith('/runtime/decision')) return {decision:approve?'allow':'deny'};
    if(route==='/runtime/audit'){events.push(body); return {ok:true};}
    throw Error('Unexpected request');
  }}); guard.tools=TOOLS; guard.observeTab(tab);
  return {guard,policy,events,backend,page,raw,frame,get invoked(){return invoked;},get requested(){return requested;}};
}
test('remote approval continues exactly one invocation; denial never invokes the backend',async()=>{
  const h=harness(); const r=await h.guard.run(h.backend,'browser_snapshot',{}); assert.ok(!r.isError); assert.equal(h.invoked,1); assert.equal(h.requested,1);
  const no=harness({approve:false}); assert.equal((await no.guard.run(no.backend,'browser_snapshot',{})).isError,true); assert.equal(no.invoked,0);
});
test('revocation, pause, arbitrary tools and file output are enforced server-side',async()=>{
  const h=harness({origins:['https://allowed.test'],approve:false});
  await h.guard.run(h.backend,'browser_snapshot',{}); h.policy.origins=[];
  assert.equal((await h.guard.run(h.backend,'browser_snapshot',{})).isError,true);
  h.policy.paused=true; assert.equal((await h.guard.run(h.backend,'browser_click',{})).isError,true);
  h.policy.paused=false;
  for(const [tool,args] of [['browser_evaluate',{expression:'1'}],['browser_snapshot',{filename:'/tmp/secret'}],['browser_click',{_meta:{cwd:'/tmp'}}]]) assert.equal((await h.guard.run(h.backend,tool,args)).isError,true);
  assert.equal(h.invoked,1);
});
test('embedded content shares page approval; top-level navigation is not replayed',async()=>{
  const h=harness({origins:['https://allowed.test'],approve:false});
  h.page.frames=()=>[h.frame,{url:()=> 'https://untrusted.test',parentFrame:()=>h.frame}];
  assert.ok(!(await h.guard.run(h.backend,'browser_snapshot',{})).isError); assert.equal(h.invoked,1); assert.equal(h.requested,0);
  h.page.frames=()=>[h.frame];
  h.backend._unguardedCallTool=async()=>{h.page.currentURL='https://untrusted.test';h.page.emit('framenavigated',h.frame);return {content:[{type:'text',text:'PRIVATE_PAGE_SENTINEL'}]};};
  const r=await h.guard.run(h.backend,'browser_click',{}); assert.equal(r.isError,true); assert.doesNotMatch(JSON.stringify(r),/PRIVATE_PAGE_SENTINEL/);
  assert.equal(h.events.at(-1).outcome,'uncertain');
});
test('audit failure stops execution, cancellation does not execute, unsafe upgrade is refused',async()=>{
  const h=harness({origins:['https://allowed.test']}); h.guard.call=async()=>{throw Error('disk full');};
  assert.equal((await h.guard.run(h.backend,'browser_click',{})).isError,true); assert.equal(h.invoked,0);
  const c=harness({origins:['https://allowed.test']}); const ac=new AbortController();ac.abort();
  assert.equal((await c.guard.run(c.backend,'browser_click',{},ac.signal)).isError,true);assert.equal(c.invoked,0);
  assert.throws(()=>transform('modified bundle'),/Unsupported/);
});
test('multi-field input rechecks the page before each actual operation',async()=>{
  const h=harness({origins:['https://allowed.test'],approve:false});let writes=0;
  h.backend._unguardedCallTool=async()=>{
    const make=()=>({locator:{fill:async()=>{writes++;h.page.currentURL='https://untrusted.test';h.page.emit('framenavigated',h.frame);}}});
    const locators=await h.guard.targets({page:h.page},async()=>[make(),make()]);
    await locators[0].locator.fill('one');await locators[1].locator.fill('two');
    return {content:[]};
  };
  const result=await h.guard.run(h.backend,'browser_fill_form',{});
  assert.equal(result.isError,true);assert.equal(writes,1);assert.equal(h.events.at(-1).outcome,'uncertain');
});
test('pinned installed bundle adapter compiles',()=>{
  const core=require.resolve('playwright-core/lib/coreBundle');
  new (require('node:vm').Script)(transform(fs.readFileSync(core,'utf8')));
});

test('embedded navigation follows the page grant without granting its destination as a tab',async()=>{
  const h=harness({origins:['https://allowed.test'],approve:false});
  await h.guard.setup(h.backend._context);
  const child={parentFrame:()=>h.frame,page:()=>h.page};
  let continued=0,blocked=0;
  const route=(url,frame)=>({request:()=>({isNavigationRequest:()=>true,url:()=>url,frame:()=>frame}),continue:async()=>continued++,abort:async()=>blocked++});
  await h.raw.handler(route('https://embedded.test/widget',child));
  assert.equal(continued,1);assert.equal(h.requested,0);
  await h.raw.handler(route('http://127.0.0.1:7331/',child));
  assert.equal(blocked,1);
  await h.raw.handler(route('https://embedded.test/',h.frame));
  assert.equal(blocked,2);assert.equal(h.requested,1);
  h.page.currentURL='https://embedded.test';
  const listed=await h.guard.run(h.backend,'browser_tabs',{action:'list'});
  assert.match(JSON.stringify(listed),/Restricted tab/);
});

test('blocked and opaque child frames cannot poison an approved page snapshot',async()=>{
  const h=harness({origins:['https://allowed.test'],approve:false});
  const child={url:()=> 'chrome-error://chromewebdata/',parentFrame:()=>h.frame};
  h.page.frames=()=>[h.frame,child];
  h.backend._unguardedCallTool=async()=>{h.page.emit('framenavigated',child);return {content:[{type:'text',text:'Main page'}]};};
  const result=await h.guard.run(h.backend,'browser_snapshot',{});
  assert.ok(!result.isError,JSON.stringify(result));assert.equal(h.requested,0);
});
