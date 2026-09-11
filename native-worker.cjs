#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {dataDir} = require('./native-control.cjs');
const {ensureService} = require('./native-control-client.cjs');
const {NativeGuard, TOOLS, SECRET_TOOL} = require('./native-guard.cjs');
const {install} = require('./native-playwright-hook.cjs');

async function main() {
  process.umask(0o077);
  const dir = dataDir(); await ensureService(dir);
  const localRequire = createRequire(path.join(__dirname, 'package.json'));
  const cli = path.join(path.dirname(localRequire.resolve('@playwright/mcp/package.json')), 'cli.js');
  const core = createRequire(cli).resolve('playwright-core/lib/coreBundle');
  const guard = new NativeGuard({dir}); guard.tools = TOOLS; guard.extraTools = [SECRET_TOOL];
  install(core, guard);
  // Read the extension credential only in the worker that needs it. Never print it.
  const tokenFile = path.join(dir, 'secrets', 'extension-token');
  if (fs.existsSync(tokenFile)) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  const artifacts = path.join(dir, 'artifacts', guard.session);
  fs.mkdirSync(artifacts, {recursive: true, mode: 0o700});
  // Test mode launches a fresh, isolated browser; it never attaches to a real profile.
  const mode = process.env.AGENT_BROWSER_TEST_EXECUTABLE ? ['--isolated', '--headless', '--sandbox', '--block-service-workers', '--executable-path', process.env.AGENT_BROWSER_TEST_EXECUTABLE] : ['--extension'];
  process.argv = [process.execPath, cli, ...mode, '--output-dir', artifacts, '--timeout-action', '10000', '--timeout-navigation', '60000', '--codegen', 'none'];
  require(cli);
}
main().catch(() => {console.error('Native browser startup failed. Verify the pinned dependencies and browser-control service.'); process.exitCode = 1;});
