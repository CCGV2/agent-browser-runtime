const {test} = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('./docker-focus.cjs');
const {configure} = require('./desktop-config.cjs');
test('focus follows the actual current tab before and after each operation without selecting a tab', async()=>{
 const events=[];
 const page = name => ({isClosed:()=>false,bringToFront:async()=>events.push(name)});
 let current=page('before');
 const backend={_context:{currentTab:()=>({page:current})},_unfocusedCallTool:async()=>{events.push('tool');current=page('after');return 'result';}};
 assert.equal(await run(backend,'browser_tabs',{},undefined),'result');
 assert.deepEqual(events,['before','tool','after']);
 backend._unfocusedCallTool=async()=>{current=undefined;throw Error('failed');};
 await assert.rejects(run(backend,'browser_close',{}),/failed/);
});
test('Openbox has one desktop and maximizes browser windows',()=>{
 const result=configure('<openbox_config><desktops><number>4</number></desktops><applications></applications></openbox_config>');
 assert.match(result,/<number>1<\/number>/);
 assert.doesNotMatch(result,/<number>4<\/number>/);
 assert.match(result,/<application class="Chromium-browser"><desktop>1<\/desktop><maximized>yes/);
 assert.throws(()=>configure('invalid'));
});
