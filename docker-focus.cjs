// Visual follow only: does not change tool permissions or expose a new API.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {createHash} = require('node:crypto');
const HASH = 'adf9246486a03bee08b2895db057ba470c62377911d291693fe783d91d6fec52';
async function focus(backend) {
  const page = backend._context?.currentTab()?.page;
  if (page && !page.isClosed()) await page.bringToFront().catch(() => {});
}
async function run(backend, name, args, signal) {
  await focus(backend);
  try { return await backend._unfocusedCallTool(name, args, signal); }
  finally { await focus(backend); }
}
function install(corePath) {
  const source = fs.readFileSync(corePath, 'utf8');
  const before = '      async callTool(name, rawArguments = {}, signal) {';
  if (createHash('sha256').update(source).digest('hex') !== HASH || source.split(before).length !== 2)
    throw Error('Unsupported Playwright bundle for Docker window follow');
  const changed = source.replace(before, '      async callTool(name, rawArguments = {}, signal) { return globalThis.__dockerWindowFollow(this, name, rawArguments, signal); }\n      async _unfocusedCallTool(name, rawArguments = {}, signal) {');
  if (require.cache[corePath]) throw Error('Playwright already loaded');
  globalThis.__dockerWindowFollow = run;
  const m = new Module(corePath, module);
  m.filename = corePath; m.paths = Module._nodeModulePaths(path.dirname(corePath));
  require.cache[corePath] = m;
  try {m._compile(changed, corePath);m.loaded = true;} catch(error) {delete require.cache[corePath];throw error;}
}
if (require.main === module) {
  const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  install(Module.createRequire(cli).resolve('playwright-core/lib/coreBundle'));
  process.argv[1] = cli;
  require(cli);
}
module.exports = {run, install};
