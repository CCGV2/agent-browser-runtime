// Captures stay in memory and never count as agent activity.
class IdleMonitor {
  constructor({timeout = 300000, now = Date.now, capture, expire}) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw Error('Invalid idle timeout');
    Object.assign(this, {timeout, now, capture, expire});
    this.lastActivity = now(); this.frame = undefined; this.busy = 0;
    this.revision = 0; this.checking = false; this.expired = false;
  }
  reset() {this.revision++; this.lastActivity = this.now(); this.expired = false;}
  begin() {this.busy++; this.reset();}
  end() {this.busy--; this.revision++; this.lastActivity = this.now();}
  async check() {
    if (this.expired || this.busy || this.checking) return;
    this.checking = true;
    const revision = this.revision;
    try {
      const frame = await this.capture();
      if (revision !== this.revision || this.busy) return;
      if (frame !== this.frame) {this.frame = frame; this.lastActivity = this.now();}
      if (this.now() - this.lastActivity >= this.timeout) {
        this.expired = true; this.expire();
      }
    } catch {this.lastActivity = this.now();} // Unknown pixels cannot prove inactivity.
    finally {this.checking = false;}
  }
}
module.exports = {IdleMonitor};
