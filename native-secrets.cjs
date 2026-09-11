// One-use credentials. Only the operator can register a file or release a hold.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class SecretStore {
  constructor(dir, {root = path.join(require('node:os').homedir(), '.paxd/secrets/transient'), now = Date.now} = {}) {
    this.root = path.resolve(root); this.now = now; this.items = new Map();
    this.dir = path.join(dir, 'secrets', 'one-use'); fs.mkdirSync(this.dir, {recursive:true, mode:0o700});
    this.holdFile = path.join(dir, 'control', 'sensitive-sessions.json');
    this.holds = new Set(fs.existsSync(this.holdFile) ? JSON.parse(fs.readFileSync(this.holdFile, 'utf8')) : []);
    // References do not survive restart. Remove orphaned payloads immediately.
    for (const name of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, name));
  }
  saveHolds() {
    const temp = this.holdFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify([...this.holds]), {mode:0o600}); fs.renameSync(temp, this.holdFile);
  }
  register({fileRef, session, origin, target, ttlMs = 60_000}) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session || '') || typeof target !== 'string' || !target.length || target.length > 512 || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120_000) throw Error('Invalid secret binding');
    const file = typeof fileRef === 'string' && fileRef.startsWith('file:') ? fileRef.slice(5) : '';
    if (path.dirname(file) !== this.root || !/^[a-f0-9-]{16,64}$/.test(path.basename(file))) throw Error('Invalid transient file reference');
    if (fs.realpathSync(this.root) !== this.root) throw Error('Transient directory must not be a symlink');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes; let dest; let owned = false;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size < 1 || stat.size > 8192) throw Error('Invalid transient secret file');
      owned = true;
      if (stat.mtimeMs + 600_000 <= this.now()) throw Error('Expired transient file');
      if (this.items.size >= 64) throw Error('Too many secret references');
      const expires = Math.min(this.now() + ttlMs, stat.mtimeMs + 600_000);
      bytes = fs.readFileSync(fd);
      const ref = crypto.randomBytes(24).toString('hex'); dest = path.join(this.dir, ref);
      fs.writeFileSync(dest, bytes, {mode:0o600, flag:'wx'});
      fs.unlinkSync(file);
      this.items.set(ref, {file:dest, session, origin, target, expires});
      return {secret_ref:ref, expires};
    } catch (e) {if (dest) fs.rmSync(dest, {force:true}); throw e;}
    finally {fs.closeSync(fd); bytes?.fill(0); if (owned) fs.rmSync(file, {force:true});}
  }
  sweep() {
    for (const [ref, item] of this.items) if (item.expires <= this.now()) {fs.rmSync(item.file, {force:true}); this.items.delete(ref);}
  }
  consume({secret_ref, session, origin, target}) {
    const item = this.items.get(secret_ref);
    if (!item) throw Error('Secret unavailable');
    this.items.delete(secret_ref);
    let bytes;
    try {
      if (item.expires <= this.now() || item.session !== session || item.origin !== origin || item.target !== target) throw Error('Secret unavailable');
      this.holds.add(session); this.saveHolds();
      bytes = fs.readFileSync(item.file);
      return {value:new TextDecoder('utf-8', {fatal:true}).decode(bytes)};
    } finally {bytes?.fill(0); fs.rmSync(item.file, {force:true});}
  }
  resume(session) {this.holds.delete(session); this.saveHolds();}
}
module.exports = {SecretStore};
