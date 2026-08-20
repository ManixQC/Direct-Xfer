'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cleanClientId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 1024 || /[\x00-\x20\x7f]/.test(id) || !id.toLowerCase().endsWith('.apps.googleusercontent.com')) return '';
  return id;
}
function cleanClientSecret(value) {
  const secret = String(value || '').trim();
  if (!secret || secret.length > 2048 || /[\r\n\0]/.test(secret)) return '';
  return secret;
}
function clientIdHint(clientId) {
  const id = String(clientId || '');
  if (!id) return '';
  if (id.length <= 26) return id;
  return `${id.slice(0, 12)}…${id.slice(-18)}`;
}

class GoogleOAuthProfileStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || '/data');
    this.file = path.resolve(options.file || path.join(this.dataDir, 'google-oauth-profile.enc.json'));
    this.keyFile = path.resolve(options.keyFile || path.join(this.dataDir, 'google-oauth-profile.key'));
    this.dataKey = String(options.dataKey || '').trim();
    this.env = options.env || process.env;
    try { fs.mkdirSync(path.dirname(this.file), { recursive:true }); } catch (_) {}
  }

  _envProfile() {
    const webId = cleanClientId(this.env.DIRECT_XFER_GOOGLE_WEB_CLIENT_ID || '');
    const webSecret = cleanClientSecret(this.env.DIRECT_XFER_GOOGLE_WEB_CLIENT_SECRET || '');
    if (webId && webSecret) return { clientId:webId, clientSecret:webSecret, kind:'web', source:'env', managed:true };
    const id = cleanClientId(this.env.DIRECT_XFER_GOOGLE_OAUTH_CLIENT_ID || this.env.RCLONE_DRIVE_CLIENT_ID || '');
    const secret = cleanClientSecret(this.env.DIRECT_XFER_GOOGLE_OAUTH_CLIENT_SECRET || this.env.RCLONE_DRIVE_CLIENT_SECRET || '');
    if (!id || !secret) return null;
    return { clientId:id, clientSecret:secret, kind:'desktop', source:'env', managed:true };
  }

  _key() {
    if (this.dataKey) return crypto.createHash('sha256').update('Direct-Xfer\0google-oauth-profile\0').update(this.dataKey).digest();
    try {
      const raw = fs.readFileSync(this.keyFile);
      if (raw.length === 32) return raw;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(this.keyFile, key, { mode:0o600, flag:'wx' });
      try { fs.chmodSync(this.keyFile, 0o600); } catch (_) {}
      return key;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const existing = fs.readFileSync(this.keyFile);
      if (existing.length !== 32) throw Object.assign(new Error('google-oauth-profile-key-invalid'), { code:'google-oauth-profile-invalid' });
      return existing;
    }
  }

  _readStored() {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw Object.assign(new Error('google-oauth-profile-invalid'), { code:'google-oauth-profile-invalid' });
    }
    try {
      if (!payload || payload.v !== 1) throw new Error('version');
      const iv = Buffer.from(String(payload.iv || ''), 'base64');
      const tag = Buffer.from(String(payload.tag || ''), 'base64');
      const data = Buffer.from(String(payload.data || ''), 'base64');
      if (iv.length !== 12 || tag.length !== 16 || !data.length) throw new Error('shape');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this._key(), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plain);
      const id = cleanClientId(parsed && parsed.clientId);
      const secret = cleanClientSecret(parsed && parsed.clientSecret);
      if (!id || !secret) throw new Error('credentials');
      return { clientId:id, clientSecret:secret, kind:String(parsed.kind || 'desktop') === 'web' ? 'web' : 'desktop', source:'stored', managed:false, savedAt:Number(parsed.savedAt) || 0 };
    } catch (error) {
      if (error && error.code === 'google-oauth-profile-invalid') throw error;
      throw Object.assign(new Error('google-oauth-profile-invalid'), { code:'google-oauth-profile-invalid' });
    }
  }

  get() { return this._envProfile() || this._readStored(); }

  status() {
    const profile = this.get();
    return profile ? {
      configured:true,
      source:profile.source,
      managed:!!profile.managed,
      clientIdHint:clientIdHint(profile.clientId),
      kind:profile.kind || 'desktop',
      savedAt:Number(profile.savedAt) || 0,
    } : { configured:false, source:'none', managed:false, clientIdHint:'', kind:'none', savedAt:0 };
  }

  save(input = {}) {
    if (this._envProfile()) throw Object.assign(new Error('google-oauth-profile-managed'), { code:'google-oauth-profile-managed' });
    const clientId = cleanClientId(input.clientId);
    const clientSecret = cleanClientSecret(input.clientSecret);
    if (!clientId) throw Object.assign(new Error('oauth-google-client-id-required'), { code:'oauth-google-client-id-required' });
    if (!clientSecret) throw Object.assign(new Error('oauth-google-client-secret-required'), { code:'oauth-google-client-secret-required' });
    const kind = String(input.kind || 'web') === 'desktop' ? 'desktop' : 'web';
    const savedAt = Date.now();
    const plain = Buffer.from(JSON.stringify({ clientId, clientSecret, kind, savedAt }), 'utf8');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key(), iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const payload = JSON.stringify({ v:1, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:encrypted.toString('base64') });
    const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, payload, { mode:0o600, flag:'wx' });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch (_) {}
    return this.status();
  }

  clear() {
    if (this._envProfile()) throw Object.assign(new Error('google-oauth-profile-managed'), { code:'google-oauth-profile-managed' });
    try { fs.unlinkSync(this.file); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return this.status();
  }
}

module.exports = { GoogleOAuthProfileStore, cleanClientId, cleanClientSecret };
