class SessionPool {
  constructor(create, grace = 300000) {
    this.create = create;
    this.grace = grace;
    this.entries = new Map();
  }
  attach(key) {
    let entry = this.entries.get(key);
    if (entry?.active) throw new Error('Session already connected');
    if (!entry) {
      entry = {worker: this.create(key), active: false};
      this.entries.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.active = true;
    return entry.worker;
  }
  detach(key, worker) {
    const entry = this.entries.get(key);
    if (!entry || entry.worker !== worker) return;
    entry.active = false;
    entry.timer = setTimeout(() => this.remove(key, worker), this.grace);
    entry.timer.unref();
  }
  remove(key, worker) {
    const entry = this.entries.get(key);
    if (!entry || entry.worker !== worker) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    worker.close();
  }
  close() {
    for (const [key, entry] of this.entries) this.remove(key, entry.worker);
  }
}
module.exports = {SessionPool};
