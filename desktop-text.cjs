// Local operator-only helper. Input and clipboard bytes never enter argv or logs.
// The authenticated caller must run this under flock. The OS owns lock lifetime,
// including SIGKILL; direct same-user execution is not a security boundary.
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 8000;
const MAX_INPUT_BYTES = 16384;
const ENV = {...process.env, DISPLAY:':99', LANG:'C.UTF-8', LC_ALL:'C.UTF-8'};

class DesktopTextError extends Error {
  constructor(code, dispatched = false) {super(code); this.code = code; this.dispatched = dispatched;}
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'text') ||
      typeof value.text !== 'string' || value.text.includes('\0') || [...value.text].length > 2000 || Buffer.byteLength(value.text) > MAX_TEXT_BYTES)
    throw new DesktopTextError('INVALID_DESKTOP_TEXT');
  // Reject unpaired surrogates instead of silently changing supplied text.
  if (Buffer.from(value.text).toString('utf8') !== value.text) throw new DesktopTextError('INVALID_DESKTOP_TEXT');
  return value.text;
}

async function command(name, args, signal) {
  try {
    return await execFileAsync('/usr/bin/' + name, args, {env:ENV, signal, timeout:1000, maxBuffer:MAX_TEXT_BYTES + 1024, encoding:'buffer'});
  } catch {throw new DesktopTextError('DESKTOP_TEXT_COMMAND_FAILED');}
}

async function focus(signal) {
  const active = (await command('xdotool',['getactivewindow'],signal)).stdout.toString().trim();
  const input = (await command('xdotool',['getwindowfocus'],signal)).stdout.toString().trim();
  if (![active,input].every(value => /^\d+$/.test(value) && BigInt(value) > 1n)) throw new DesktopTextError('DESKTOP_FOCUS_UNAVAILABLE');
  return active + '/' + input;
}

function delay(ms, signal) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new DesktopTextError('DESKTOP_TEXT_CANCELLED'));
    const aborted = () => {clearTimeout(timer);reject(new DesktopTextError('DESKTOP_TEXT_CANCELLED'));};
    const timer = setTimeout(() => {signal?.removeEventListener('abort',aborted);resolve();},ms);
    signal?.addEventListener('abort',aborted,{once:true});
  });
}

function ownClipboard(text, signal) {
  const child = spawn('/usr/bin/xclip',['-selection','clipboard','-in','-target','UTF8_STRING','-quiet'], {env:ENV, stdio:['pipe','ignore','pipe']});
  let requests = 0;
  let failed = false;
  let line = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve,reject) => {readyResolve=resolve;readyReject=reject;});
  const timer = setTimeout(() => readyReject(new DesktopTextError('CLIPBOARD_NOT_READY')),1000);
  child.stderr.on('data',bytes => {
    line += bytes.toString();
    if (line.length > 4096) line = line.slice(-4096);
    if (line.includes('Waiting for selection requests')) {clearTimeout(timer);readyResolve();}
    for (const match of line.matchAll(/Waiting for selection request number (\d+)/g)) requests = Math.max(requests,Number(match[1])-1);
    const last = line.lastIndexOf('\n'); if (last >= 0) line = line.slice(last+1);
  });
  const fail = () => {failed=true;clearTimeout(timer);readyReject(new DesktopTextError('CLIPBOARD_NOT_READY'));};
  child.on('error',fail); child.on('exit',fail); child.stdin.on('error',fail);
  child.stdin.end(text);
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort',abort,{once:true});
  return {ready, requests:()=>requests, failed:()=>failed, async close() {
    clearTimeout(timer); signal?.removeEventListener('abort',abort);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit',resolve));
    child.kill('SIGTERM');
    await Promise.race([exited,new Promise(resolve => setTimeout(resolve,150))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }};
}

async function pasteDesktopText(text, signal) {
  if (!text) return {ok:true,dispatched:false};
  let clipboard, dispatched = false;
  try {
    const target = await focus(signal);
    clipboard = ownClipboard(text,signal);
    await clipboard.ready;
    const readback = await command('xclip',['-selection','clipboard','-out','-target','UTF8_STRING'],signal);
    const correct = readback.stdout.equals(Buffer.from(text));
    readback.stdout.fill(0);
    if (!correct || clipboard.failed()) throw new DesktopTextError('CLIPBOARD_NOT_READY');
    await delay(0,signal); // Drain completed readback request metadata.
    const baseline = clipboard.requests();
    if (await focus(signal) !== target) throw new DesktopTextError('DESKTOP_FOCUS_CHANGED');
    dispatched = true;
    await command('xdotool',['key','--clearmodifiers','ctrl+v'],signal);
    // Chromium requests TARGETS then UTF8_STRING. Keep the owner alive while
    // both requests complete; never use -loops 1, which can stop at TARGETS.
    const deadline = Date.now()+2000;
    while (clipboard.requests() < baseline+2 && !clipboard.failed() && Date.now() < deadline) await delay(10,signal);
    if (clipboard.failed() || clipboard.requests() < baseline+2) throw new DesktopTextError('DESKTOP_PASTE_UNCONFIRMED',true);
    await delay(100,signal);
    return {ok:true,dispatched:true};
  } catch(error) {
    throw new DesktopTextError(error instanceof DesktopTextError ? error.code : 'DESKTOP_TEXT_FAILED',dispatched);
  } finally {
    await clipboard?.close();
  }
}

async function readRequest(input, signal) {
  let size = 0; const chunks=[];
  for await (const chunk of input) {
    if (signal?.aborted) throw new DesktopTextError('DESKTOP_TEXT_CANCELLED');
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new DesktopTextError('INVALID_DESKTOP_TEXT');
    chunks.push(chunk);
  }
  try {return validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
  catch {throw new DesktopTextError('INVALID_DESKTOP_TEXT');}
}

if (require.main === module) {
  process.umask(0o077);
  const controller = new AbortController();
  const abort = () => {controller.abort();process.stdin.destroy();};
  const timer = setTimeout(abort,5000);
  process.once('SIGTERM',abort);process.once('SIGINT',abort);
  (async()=>{
    try {process.stdout.write(JSON.stringify(await pasteDesktopText(await readRequest(process.stdin,controller.signal),controller.signal))+'\n');}
    catch(error) {
      const result = error instanceof DesktopTextError ? error : new DesktopTextError('DESKTOP_TEXT_FAILED');
      process.stdout.write(JSON.stringify({error:result.code,dispatched:result.dispatched})+'\n');
      process.exitCode=1;
    } finally {clearTimeout(timer);process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);}
  })();
}
module.exports={validateRequest,pasteDesktopText,DesktopTextError};
