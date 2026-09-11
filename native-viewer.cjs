const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
class ViewerStore {
  constructor(dir) {this.workers = new Map(); this.pending = new Map(); this.file = path.join(dir, 'control', 'operator.json'); this.owner = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;}
  setOwner(owner) {const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(owner), {mode:0o600}); fs.renameSync(temp, this.file); this.owner = owner;}
  sweep() {
    const now = Date.now();
    for (const [id, w] of this.workers) if (now - w.seen > 15_000) this.workers.delete(id);
    // An absent worker never silently hands control back to the agent.
    for (const [id, job] of this.pending) if (job.expires <= now) {this.pending.delete(id); job.resolve({error:'Viewer operation timed out; inspect before retrying'});}
  }
  poll(session) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session || '')) throw Error('Invalid browser session');
    this.sweep(); this.workers.set(session, {session, seen:Date.now()});
    const job = [...this.pending.values()].find(p => p.session === session && !p.sent);
    if (!job) return {};
    job.sent = true; return {id:job.id, action:job.action};
  }
  finish({session, id, result}) {
    const job = this.pending.get(id);
    if (!job || job.session !== session || !job.sent) return;
    this.pending.delete(id); job.resolve(result);
  }
  async request({session, action}) {
    this.sweep();
    if (action?.type === 'release') {
      if (this.owner !== session) throw Error('Viewer is owned by another session');
      this.setOwner(null); return {ok:true};
    }
    if (!this.workers.has(session)) throw Error('Browser worker is not connected');
    if (action?.type === 'takeover') {if (this.owner && this.owner !== session) throw Error('Another session has control'); this.setOwner(session); return {ok:true};}
    if (this.owner !== session) throw Error('Take control before viewing or interacting');
    if (!['screenshot','click','key','scroll','text'].includes(action?.type)) throw Error('Unsupported viewer action');
    if (this.pending.size >= 2) throw Error('Viewer is busy');
    const id = crypto.randomUUID();
    return new Promise(resolve => this.pending.set(id, {id, session, action, resolve, expires:Date.now()+7000, sent:false}));
  }
}
module.exports = {ViewerStore};
