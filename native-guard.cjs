const crypto = require('node:crypto');
const {request} = require('./native-control-client.cjs');
const {normalizeOrigin, PORT} = require('./native-control.cjs');

const TOOLS = new Set(['browser_fill_secret', 'browser_navigate', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_fill_form', 'browser_type', 'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_tabs', 'browser_wait_for', 'browser_take_screenshot', 'browser_close']);
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
  async policy() {const p = await this.call('/runtime/policy?v=2&session=' + this.session); if (p.paused) throw new PolicyError('BROWSER_CONTROL_PAUSED'); if (p.operator && !this.inOperator) throw new PolicyError('OPERATOR_HAS_CONTROL'); if (p.sensitive && !this.fillingSecret && !this.inOperator) throw new PolicyError('SENSITIVE_SESSION_HELD; operator must resume browser control'); return p;}
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
  pageOrigin(page) {
    return this.frameOrigin(page.mainFrame());
  }
  pageAllowed(page, policy) {
    const origin = this.pageOrigin(page);
    return !origin || policy.origins.includes(origin);
  }
  async checkPage(page, wait = false, signal) {
    let policy = await this.policy();
    // Site approval covers the displayed page, including its embedded content.
    const origins = [this.pageOrigin(page)].filter(Boolean);
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
      if (!scope || !scope.pages.has(page) || frame.parentFrame()) return;
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
      if (!this.pageAllowed(tab.page, p)) throw new PolicyError('RESTRICTED_TAB');
      if (this.scope) {this.scope.pages.add(tab.page); this.scope.allowed = new Set(p.origins);}
      const result = await original();
      const latest = await this.policy();
      if (!this.pageAllowed(tab.page, latest)) throw new PolicyError('RESTRICTED_TAB');
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
      const embedded = !!req.frame().parentFrame();
      try {
        // Keep special schemes and the management origin blocked in all frames.
        const destination = originOf(req.url(), this.port);
        const origin = embedded ? this.pageOrigin(req.frame().page()) : destination;
        const p = await this.policy();
        if (!p.origins.includes(origin)) {
          const tool = this.scope?.tool || 'browser_navigate';
          await this.call('/runtime/request', {session: this.session, origin, tool, requestId: this.scope?.requestId});
          await this.audit('navigation.blocked', {origin, tool});
          if (this.scope && !embedded) this.scope.breach = true;
          await route.abort('blockedbyclient'); return;
        }
        await route.continue();
      } catch {if (this.scope && !embedded) this.scope.breach = true; await route.abort('blockedbyclient').catch(() => {});}
    });
  }
  startViewer(backend) {
    if (this.viewerTimer) return;
    let polling = false;
    this.viewerTimer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const job = await this.call('/runtime/view-poll', {session:this.session});
        if (job.id) {
          const work = this.tail.then(() => this.operatorAction(backend, job.action));
          this.tail = work.catch(() => {});
          await this.call('/runtime/view-result', {session:this.session, id:job.id, result:await work});
        }
      } catch {} finally {polling = false;}
    }, 300);
    this.viewerTimer.unref();
  }
  async operatorAction(backend, action) {
    this.inOperator = true;
    try {
      const policy = await this.policy();
      if (policy.operator !== this.session) throw Error('No takeover');
      const tab = await backend._context.ensureTab(); const page = tab.page;
      await this.checkPage(page);
      const url = page.url();
      if (action.type === 'screenshot') {
        const bytes = await page.screenshot({type:'jpeg', quality:65, timeout:4000});
        await this.checkPage(page);
        if (page.url() !== url || bytes.length > 600_000) throw Error('Frame invalid');
        const size = await page.evaluate(() => ({width:innerWidth, height:innerHeight}));
        this.viewerFrame = {id:crypto.randomUUID(), page, url, size, expires:Date.now()+5000};
        return {frame:this.viewerFrame.id, image:bytes.toString('base64'), ...size};
      }
      const frame = this.viewerFrame; this.viewerFrame = null;
      if (!frame || frame.id !== action.frame || frame.page !== page || frame.url !== url || frame.expires < Date.now()) throw Error('Stale frame');
      if (action.type === 'click') {
        if (![action.x,action.y].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= frame.size.width || action.y >= frame.size.height) throw Error('Coordinates invalid');
        await page.mouse.click(action.x, action.y, {timeout:4000});
      } else if (action.type === 'scroll') {
        if (![action.x,action.y].every(n => Number.isFinite(n) && Math.abs(n) <= 2000)) throw Error('Scroll invalid');
        await page.mouse.wheel(action.x, action.y);
      } else if (action.type === 'key') {
        if (!['Enter','Tab','Shift+Tab','Backspace','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Delete','ControlOrMeta+A'].includes(action.key)) throw Error('Key invalid');
        await page.keyboard.press(action.key);
      } else if (action.type === 'text') {
        if (typeof action.text !== 'string' || action.text.length > 4096) throw Error('Text invalid');
        await page.keyboard.insertText(action.text);
      } else throw Error('Action invalid');
      await this.checkPage(page);
      return {ok:true};
    } catch {return {error:'Viewer action failed or frame changed; refresh before retrying'};}
    finally {this.inOperator = false;}
  }
  async fillSecret(context, args, signal) {
    let credential;
    try {
      credential = await this.call('/runtime/consume-secret', {...args, session:this.session});
      this.fillingSecret = true;
      if (signal?.aborted) throw Error('Cancelled');
      const tab = await context.ensureTab();
      await this.checkPage(tab.page);
      if (originOf(tab.page.url(), this.port) !== args.origin) throw Error('Origin changed');
      const {locator} = await tab.targetLocator({target:args.target});
      // Check origin and field type in the same renderer task as the assignment.
      // Never ask upstream MCP to fill: it automatically produces snapshots.
      await locator.evaluate((el, {value, origin}) => {
        if (location.origin !== origin || !(el instanceof HTMLInputElement) || el.type !== 'password' || el.disabled || el.readOnly || !el.isConnected) throw Error('Invalid password target');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      }, {value:credential.value, origin:args.origin}, {timeout:5000});
      return {content:[{type:'text', text:'Password filled. Browser tools are held until the operator resumes. No submit action was requested.'}]};
    } catch {throw new PolicyError('SECRET_FILL_FAILED; reference is not reusable; operator must inspect before resuming');}
    finally {this.fillingSecret = false; if (credential) credential.value = undefined;}
  }
  run(backend, tool, args, signal) {
    // MCP clients may pipeline requests. Approval and browser selection are serialized.
    this.startViewer(backend);
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
      if (policy.sensitive) throw new PolicyError('SENSITIVE_SESSION_HELD; operator must resume browser control');
      this.scope.allowed = new Set(policy.origins);
      const context = backend._context;
      await this.setup(context);
      if (tool === 'browser_fill_secret') {
        result = await this.fillSecret(context, args, signal);
      } else if (tool === 'browser_navigate' || tool === 'browser_tabs' && args.action === 'new' && args.url) {
        origin = originOf(args.url, this.port);
        policy = await this.need(origin, tool, true, signal);
        this.scope.allowed = new Set(policy.origins);
        const tab = await context.ensureTab(); this.scope.pages.add(tab.page);
      } else if (tool === 'browser_tabs' && args.action === 'list') {
        const lines = [];
        for (const [i, tab] of context.tabs().entries()) {
          try {
            const p = await this.policy();
            if (!this.pageAllowed(tab.page, p)) throw new PolicyError('RESTRICTED_TAB');
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
const SECRET_TOOL = {name:'browser_fill_secret', description:'Fill an operator-authorized, single-use password reference. Does not submit. Further tools pause until operator resumes.', inputSchema:{type:'object', properties:{secret_ref:{type:'string'}, origin:{type:'string'}, target:{type:'string'}}, required:['secret_ref','origin','target'], additionalProperties:false}};
module.exports = {SECRET_TOOL, NativeGuard, PolicyError, TOOLS, originOf};
