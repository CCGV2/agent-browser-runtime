const crypto = require('node:crypto');
const {request} = require('./native-control-client.cjs');
const {normalizeOrigin, PORT} = require('./native-control.cjs');

const TOOLS = new Set(['browser_navigate', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_fill_form', 'browser_type', 'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_tabs', 'browser_wait_for', 'browser_take_screenshot', 'browser_close']);
class PolicyError extends Error { constructor(code) {super(code); this.code = code;} }
function originOf(url, port) {
  try {const u = new URL(url); return normalizeOrigin(u.origin, port);} catch {throw new PolicyError('UNSUPPORTED_OR_MANAGEMENT_ORIGIN');}
}
function errorResult(code) {return {isError: true, content: [{type: 'text', text: code}]};}
class NativeGuard {
  constructor({dir, port = Number(process.env.AGENT_BROWSER_CONTROL_PORT || PORT), session = crypto.randomUUID(), timeout = 90_000, call} = {}) {
    this.dir = dir; this.port = port; this.session = session; this.timeout = timeout;
    this.call = call || ((route, body) => request(dir, 'runtime', route, body, {port}));
    this.pages = new WeakSet(); this.contexts = new WeakSet(); this.tail = Promise.resolve(); this.scope = null;
  }
  async policy() {const p = await this.call('/runtime/policy?session=' + this.session); if (p.paused) throw new PolicyError('BROWSER_CONTROL_PAUSED'); return p;}
  audit(event, fields) {return this.call('/runtime/audit', {event, session: this.session, ...fields});}
  async need(origin, tool, wait, signal) {
    let p = await this.policy();
    if (p.origins.includes(origin)) return p;
    const pending = await this.call('/runtime/request', {session: this.session, origin, tool, requestId: this.scope?.requestId});
    if (!wait) throw new PolicyError(`SITE_APPROVAL_REQUIRED ${pending.id}; approve in browser control, then inspect the page before retrying any action`);
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new PolicyError('REQUEST_CANCELLED');
      p = await this.policy();
      if (p.origins.includes(origin)) return p;
      const status = await this.call('/runtime/decision?id=' + pending.id + '&session=' + this.session);
      if (['deny', 'expired'].includes(status.decision)) throw new PolicyError('SITE_APPROVAL_DENIED_OR_EXPIRED');
      await new Promise(r => setTimeout(r, 250));
    }
    throw new PolicyError('SITE_APPROVAL_TIMEOUT; approve in browser control and retry the request');
  }
  frameOrigin(frame) {
    const url = frame.url();
    if (['', 'about:blank', 'about:srcdoc'].includes(url)) return frame.parentFrame() ? this.frameOrigin(frame.parentFrame()) : null;
    return originOf(url, this.port);
  }
  async checkPage(page, wait = false, signal) {
    let policy = await this.policy();
    const origins = [...new Set(page.frames().map(f => this.frameOrigin(f)).filter(Boolean))];
    for (const origin of origins) {
      if (!policy.origins.includes(origin)) policy = await this.need(origin, this.scope?.tool || 'browser_snapshot', wait, signal);
    }
    policy = await this.policy();
    if (origins.some(o => !policy.origins.includes(o))) throw new PolicyError('PAGE_PERMISSION_REVOKED');
    if (this.scope) {this.scope.allowed = new Set(policy.origins); this.scope.pages.add(page);}
    return policy;
  }
  observeTab(tab) {
    // Automatic console artifacts and downloads are outside the MVP tool surface.
    tab._handleConsoleMessage = () => {};
    tab._downloadStarted = async download => {
      await download.cancel().catch(() => {});
      await this.audit('download.cancelled', {tool: this.scope?.tool || 'browser_snapshot'}).catch(() => {});
    };
    const page = tab.page;
    if (this.pages.has(page)) return;
    this.pages.add(page);
    this.wrapOperations(page, page, ['screenshot']);
    if (page.keyboard) this.wrapOperations(page.keyboard, page, ['press', 'type', 'insertText', 'down', 'up']);
    page.on('framenavigated', frame => {
      const scope = this.scope;
      if (!scope || !scope.pages.has(page)) return;
      try {const o = this.frameOrigin(frame); if (o && !scope.allowed.has(o)) scope.breach = true;}
      catch {scope.breach = true;}
    });
  }
  wrapOperations(object, page, methods) {
    for (const method of methods) {
      if (typeof object[method] !== 'function') continue;
      const original = object[method].bind(object);
      object[method] = async (...args) => {
        await this.checkPage(page);
        if (this.scope?.breach) throw new PolicyError('PAGE_SCOPE_CHANGED');
        return original(...args);
      };
    }
  }
  async header(tab, original) {
    try {
      const p = await this.policy();
      if (tab.page.frames().some(f => {const o = this.frameOrigin(f); return o && !p.origins.includes(o);})) throw new PolicyError('RESTRICTED_TAB');
      if (this.scope) {this.scope.pages.add(tab.page); this.scope.allowed = new Set(p.origins);}
      const result = await original();
      const latest = await this.policy();
      if (tab.page.frames().some(f => {const o = this.frameOrigin(f); return o && !latest.origins.includes(o);})) throw new PolicyError('RESTRICTED_TAB');
      if (this.scope?.breach) throw new PolicyError('PAGE_SCOPE_CHANGED');
      return result;
    }
    catch {return {title: '[Restricted tab]', url: 'about:blank', current: tab.isCurrentTab(), crashed: false, console: {total: 0, warnings: 0, errors: 0}, changed: true};}
  }
  async snapshot(tab, original) {
    await this.checkPage(tab.page);
    const result = await original();
    await this.checkPage(tab.page);
    if (this.scope?.breach) throw new PolicyError('PAGE_SCOPE_CHANGED; inspect again after authorization');
    // Events may refer to content from an earlier origin; do not expose that history.
    return {...result, events: [], consoleLink: undefined};
  }
  async targets(tab, original) {
    await this.checkPage(tab.page);
    const results = await original();
    for (const item of results) this.wrapOperations(item.locator, tab.page, ['click','dblclick','fill','type','press','pressSequentially','hover','selectOption','check','uncheck','setChecked']);
    return results;
  }
  async setup(context) {
    const raw = await context.ensureBrowserContext();
    if (this.contexts.has(raw)) return;
    this.contexts.add(raw);
    await raw.route('**/*', async route => {
      const req = route.request();
      if (!req.isNavigationRequest()) {await route.continue().catch(() => {}); return;}
      try {
        const origin = originOf(req.url(), this.port);
        const p = await this.policy();
        if (!p.origins.includes(origin)) {
          const tool = this.scope?.tool || 'browser_navigate';
          await this.call('/runtime/request', {session: this.session, origin, tool, requestId: this.scope?.requestId});
          await this.audit('navigation.blocked', {origin, tool});
          if (this.scope) this.scope.breach = true;
          await route.abort('blockedbyclient'); return;
        }
        await route.continue();
      } catch {if (this.scope) this.scope.breach = true; await route.abort('blockedbyclient').catch(() => {});}
    });
  }
  run(backend, tool, args, signal) {
    // MCP clients may pipeline requests. Approval and browser selection are serialized.
    const work = this.tail.then(() => this.execute(backend, tool, args, signal));
    this.tail = work.catch(() => {}); return work;
  }
  async execute(backend, tool, args, signal) {
    const requestId = crypto.randomUUID(); const start = Date.now();
    let outcome = 'denied'; let origin; let result;
    this.scope = {tool, requestId, pages: new Set(), allowed: new Set(), breach: false};
    try {
      await this.audit('tool.started', {requestId, tool});
      if (!TOOLS.has(tool)) throw new PolicyError('TOOL_NOT_ALLOWED');
      if (args._meta || args.filename || args.path || args.file || args.code) throw new PolicyError('FILE_AND_CODE_ARGUMENTS_NOT_ALLOWED');
      if (signal?.aborted) throw new PolicyError('REQUEST_CANCELLED');
      let policy = await this.policy();
      this.scope.allowed = new Set(policy.origins);
      const context = backend._context;
      await this.setup(context);
      if (tool === 'browser_navigate' || tool === 'browser_tabs' && args.action === 'new' && args.url) {
        origin = originOf(args.url, this.port);
        policy = await this.need(origin, tool, true, signal);
        this.scope.allowed = new Set(policy.origins);
        const tab = await context.ensureTab(); this.scope.pages.add(tab.page);
      } else if (tool === 'browser_tabs' && args.action === 'list') {
        const lines = [];
        for (const [i, tab] of context.tabs().entries()) {
          try {
            const p = await this.policy();
            if (tab.page.frames().some(f => {const o = this.frameOrigin(f); return o && !p.origins.includes(o);})) throw new PolicyError('RESTRICTED_TAB');
            lines.push(`${i}: ${tab.page.url() === 'about:blank' ? 'about:blank' : originOf(tab.page.url(), this.port)}`);
          }
          catch {lines.push(`${i}: [Restricted tab]`);}
        }
        result = {content: [{type: 'text', text: lines.join('\n') || 'No tabs'}]};
      } else if (tool !== 'browser_close') {
        const target = tool === 'browser_tabs' && ['select','close'].includes(args.action) && args.index !== undefined ? context.tabs()[args.index] : await context.ensureTab();
        if (!target) throw new PolicyError('TAB_NOT_FOUND');
        await this.checkPage(target.page, true, signal);
        if (target.page.url() !== 'about:blank') origin = originOf(target.page.url(), this.port);
      }
      if (!result) {
        if (signal?.aborted) throw new PolicyError('REQUEST_CANCELLED');
        outcome = 'started';
        result = await backend._unguardedCallTool(tool, args, signal);
        // Recheck every page touched by this operation after Playwright builds the response.
        if (tool !== 'browser_close') for (const page of this.scope.pages) if (!page.isClosed()) await this.checkPage(page);
        if (this.scope.breach) throw new PolicyError('NAVIGATION_BLOCKED_OR_SCOPE_CHANGED; the action may have executed; authorize and inspect before retrying, do not replay automatically');
      }
      outcome = result.isError ? 'error' : 'success';
    } catch (e) {
      if (outcome === 'started') outcome = 'uncertain';
      result = errorResult(e instanceof PolicyError ? e.message : 'BROWSER_CONTROL_UNAVAILABLE; operation stopped');
    } finally {
      this.scope = null;
    }
    try {await this.audit('tool.finished', {requestId, tool, origin, outcome, durationMs: Date.now() - start});}
    catch {return errorResult('AUDIT_UNAVAILABLE; completion may be uncertain; do not replay automatically');}
    return result;
  }
}
module.exports = {NativeGuard, PolicyError, TOOLS, originOf};
