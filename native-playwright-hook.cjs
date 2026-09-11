// Small, fail-closed adapter for the exact npm artifact in package-lock.json.
// Changes are compiled in memory. Never edit the installed dependency on disk.
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const PINNED_HASH = 'adf9246486a03bee08b2895db057ba470c62377911d291693fe783d91d6fec52';
const KEY = '__agentBrowserNativeGuard';
function transform(source) {
  if (crypto.createHash('sha256').update(source).digest('hex') !== PINNED_HASH) throw Error('Unsupported Playwright bundle; browser policy adapter requires revalidation');
  const changes = [
    ['      async callTool(name, rawArguments = {}, signal) {', `      async callTool(name, rawArguments = {}, signal) { return globalThis.${KEY}.run(this, name, rawArguments, signal); }\n      async _unguardedCallTool(name, rawArguments = {}, signal) {`],
    ['        page[tabSymbol] = this;', `        globalThis.${KEY}.observeTab(this);\n        page[tabSymbol] = this;`],
    ['      async headerSnapshot() {', `      async headerSnapshot() { return globalThis.${KEY}.header(this, () => this._unguardedHeaderSnapshot()); }\n      async _unguardedHeaderSnapshot() {`],
    ['      async captureSnapshot(root, depth, boxes, relativeTo, ariaFormat = "text") {', `      async captureSnapshot(...args) { return globalThis.${KEY}.snapshot(this, () => this._unguardedCaptureSnapshot(...args)); }\n      async _unguardedCaptureSnapshot(root, depth, boxes, relativeTo, ariaFormat = "text") {`],
    ['      async targetLocators(params2) {', `      async targetLocators(params2) { return globalThis.${KEY}.targets(this, () => this._unguardedTargetLocators(params2)); }\n      async _unguardedTargetLocators(params2) {`],
    ['factory.toolSchemas.map((s) => toMcpTool(s))', `factory.toolSchemas.filter(s => globalThis.${KEY}.tools.has(s.name)).map((s) => toMcpTool(s)).concat(globalThis.${KEY}.extraTools || [])`],
  ];
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw Error('Playwright hook shape changed; refusing unguarded startup');
    source = source.replace(before, after);
  }
  return source;
}
function install(corePath, guard) {
  const resolved = path.resolve(corePath);
  if (require.cache[resolved]) throw Error('Playwright loaded before policy adapter');
  const source = transform(fs.readFileSync(resolved, 'utf8'));
  globalThis[KEY] = guard;
  const m = new Module(resolved, module); m.filename = resolved; m.paths = Module._nodeModulePaths(path.dirname(resolved));
  require.cache[resolved] = m;
  try {m._compile(source, resolved); m.loaded = true;} catch(e) {delete require.cache[resolved]; throw e;}
}
module.exports = {install, transform, PINNED_HASH};
