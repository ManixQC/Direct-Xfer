'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT || process.env.DIRECT_XFER_OAUTH_BROKER_PORT || 55810) || 55810));
const HOST = String(process.env.HOST || process.env.DIRECT_XFER_OAUTH_BROKER_HOST || '0.0.0.0');
const PUBLIC_URL = cleanBaseUrl(process.env.DIRECT_XFER_OAUTH_BROKER_PUBLIC_URL || '');
const GOOGLE_CLIENT_ID = String(process.env.DIRECT_XFER_GOOGLE_WEB_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.DIRECT_XFER_GOOGLE_WEB_CLIENT_SECRET || '').trim();
const DATA_DIR = path.resolve(process.env.DIRECT_XFER_OAUTH_BROKER_DATA_DIR || '/data');
const STORE_FILE = path.join(DATA_DIR, 'google-credentials.enc.json');
const KEY_FILE = path.join(DATA_DIR, 'broker-data.key');
const SESSION_TTL_MS = Math.max(2 * 60 * 1000, Number(process.env.DIRECT_XFER_OAUTH_BROKER_SESSION_TTL_MS || 15 * 60 * 1000));
const CREDENTIAL_TTL_MS = Math.max(24 * 60 * 60 * 1000, Number(process.env.DIRECT_XFER_OAUTH_BROKER_CREDENTIAL_TTL_MS || 365 * 24 * 60 * 60 * 1000));
const GOOGLE_DRIVE_SCOPES = Object.freeze({
  limited:'https://www.googleapis.com/auth/drive.file',
  readonly:'https://www.googleapis.com/auth/drive.readonly',
  full:'https://www.googleapis.com/auth/drive',
});
function normalizeGoogleDriveScope(value, fallback = GOOGLE_DRIVE_SCOPES.limited) {
  const raw=String(value||'').trim();
  if(!raw)return fallback;
  for(const [mode,uri] of Object.entries(GOOGLE_DRIVE_SCOPES)){
    if(raw===mode||raw===uri||raw===uri.replace('https://www.googleapis.com/auth/',''))return uri;
  }
  return '';
}
const sessions = new Map();
const rateBuckets = new Map();

function cleanBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','::1'].includes(url.hostname))) throw new Error('broker-public-url-must-be-https');
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error('broker-public-url-invalid');
  return url.origin;
}
function base64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeEqual(a,b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8', 'Content-Length':data.length,
    'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  });
  res.end(data);
}
function html(res, status, title, message, close = false, extraHeaders = {}) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const nonce = base64url(crypto.randomBytes(18));
  const script = close ? `<script nonce="${nonce}">try{window.opener&&window.opener.postMessage({type:'dx-oauth-broker-complete'},'*')}catch(_){}setTimeout(()=>window.close(),350);</script>` : '';
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:640px;padding:32px;text-align:center"><h1>${esc(title)}</h1><p>${esc(message)}</p></main>${script}</body></html>`;
  res.writeHead(status, {
    'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer', 'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    ...extraHeaders,
  });
  res.end(body);
}

function newOAuthBrowserCookie() {
  const suffix = base64url(crypto.randomBytes(12));
  return `__Host-dxo_${suffix}`;
}
function cookieValue(req, name) {
  if (!name) return '';
  const raw = String(req.headers && req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { return ''; }
  }
  return '';
}
function googleAuthorizationUrl(item) {
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const challenge = base64url(crypto.createHash('sha256').update(item.verifier).digest());
  auth.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${PUBLIC_URL}/v1/google/callback`);
  auth.searchParams.set('response_type','code');
  auth.searchParams.set('scope',item.scope);
  auth.searchParams.set('access_type','offline');
  auth.searchParams.set('prompt','consent');
  auth.searchParams.set('state',item.state);
  auth.searchParams.set('code_challenge',challenge);
  auth.searchParams.set('code_challenge_method','S256');
  return auth;
}

function clientIp(req) { return String(req.socket && req.socket.remoteAddress || 'unknown').replace(/^::ffff:/,''); }
function allowRate(req, key, limit, windowMs) {
  const now = Date.now(), id = `${key}:${clientIp(req)}`;
  const entry = rateBuckets.get(id);
  if (!entry || now - entry.start >= windowMs) { rateBuckets.set(id, { start:now, count:1 }); return true; }
  entry.count++;
  return entry.count <= limit;
}
function parseBasicAuth(req) {
  const raw = String(req.headers.authorization || '');
  if (!/^Basic\s+/i.test(raw)) return null;
  try {
    const text = Buffer.from(raw.replace(/^Basic\s+/i,''), 'base64').toString('utf8');
    const idx = text.indexOf(':'); if (idx < 0) return null;
    return { id:decodeURIComponent(text.slice(0,idx)), secret:decodeURIComponent(text.slice(idx+1)) };
  } catch (_) { return null; }
}
async function readBody(req, max = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('body-too-large'), { code:'body-too-large' }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function parseJson(req) {
  const raw = await readBody(req); if (!raw) return {};
  const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-json');
  return parsed;
}
async function parseForm(req) { return new URLSearchParams(await readBody(req)); }

function loadMasterKey() {
  fs.mkdirSync(DATA_DIR, { recursive:true, mode:0o700 });
  const provided = String(process.env.DIRECT_XFER_OAUTH_BROKER_DATA_KEY || '');
  if (provided) return crypto.createHash('sha256').update('Direct-Xfer\0OAuthBroker\0').update(provided).digest();
  try {
    const key = fs.readFileSync(KEY_FILE); if (key.length !== 32) throw new Error('invalid-key-file'); return key;
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32); fs.writeFileSync(KEY_FILE, key, { mode:0o600, flag:'wx' }); return key;
  }
}
const MASTER_KEY = loadMasterKey();
function encryptText(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  return { v:1, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:ciphertext.toString('base64') };
}
function decryptText(obj) {
  if (!obj || obj.v !== 1) throw new Error('credential-cipher-invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(obj.iv,'base64'));
  decipher.setAuthTag(Buffer.from(obj.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(obj.data,'base64')), decipher.final()]).toString('utf8');
}
function loadStore() {
  try { const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : { credentials:{} }; }
  catch (error) { if (error && error.code === 'ENOENT') return { credentials:{} }; throw error; }
}
let store = loadStore();
if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};
function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive:true, mode:0o700 });
  const tmp = `${STORE_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode:0o600 });
  fs.renameSync(tmp, STORE_FILE);
}
function createCredential(googleRefreshToken, scope) {
  const id = `dxc_${base64url(crypto.randomBytes(18))}`;
  const secret = base64url(crypto.randomBytes(32));
  const refreshHandle = `dxr_${base64url(crypto.randomBytes(24))}`;
  store.credentials[id] = {
    secretHash:sha256(secret), refreshHash:sha256(refreshHandle), googleRefreshToken:encryptText(googleRefreshToken),
    scope:String(scope || GOOGLE_DRIVE_SCOPES.limited), createdAt:Date.now(), lastUsedAt:Date.now(), expiresAt:Date.now()+CREDENTIAL_TTL_MS,
  };
  saveStore();
  return { id, secret, refreshHandle };
}
function getCredential(id, secret, refreshHandle) {
  const item = store.credentials[String(id || '')];
  if (!item || item.expiresAt < Date.now()) return null;
  if (!safeEqual(item.secretHash, sha256(secret)) || !safeEqual(item.refreshHash, sha256(refreshHandle))) return null;
  return item;
}
async function googleTokenRequest(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json'}, body:new URLSearchParams(params),
  });
  let data = null; try { data = await response.json(); } catch (_) {}
  if (!response.ok || !data || !data.access_token) {
    const code = String(data && data.error || 'google-token-exchange-failed');
    throw Object.assign(new Error(code), { code, status:response.status });
  }
  return data;
}
function publicInfo() {
  return { service:'direct-xfer-oauth-broker', version:'2', runtime:'node', google:!!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && PUBLIC_URL), callbackUrl:PUBLIC_URL ? `${PUBLIC_URL}/v1/google/callback` : '' };
}
function cleanSessions() {
  const now = Date.now();
  const cutoff = now - SESSION_TTL_MS;
  for (const [id,item] of sessions) if (!item || item.createdAt < cutoff) sessions.delete(id);
  let changed = false;
  for (const [id,item] of Object.entries(store.credentials)) {
    if (!item || Number(item.expiresAt) < now) { delete store.credentials[id]; changed = true; }
  }
  // Avoid an unbounded in-memory map on a long-running public broker when many
  // different client IPs hit the rate-limited endpoints.
  for (const [id, entry] of rateBuckets) {
    if (!entry || now - Number(entry.start || 0) > 24 * 60 * 60 * 1000) rateBuckets.delete(id);
  }
  if (changed) saveStore();
}
setInterval(cleanSessions, 60 * 1000).unref();

async function handle(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://broker.local');
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/v1/info')) return json(res, 200, publicInfo());
    if (!PUBLIC_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return json(res, 503, { error:'broker-google-not-configured' });

    if (req.method === 'POST' && url.pathname === '/v1/google/sessions') {
      if (!allowRate(req, 'google-session', 30, 60 * 60 * 1000)) return json(res, 429, { error:'rate-limited' });
      const body = await parseJson(req); const version = String(body.version || '').slice(0,64);
      const requestedScope = normalizeGoogleDriveScope(body.scope);
      if (!requestedScope) return json(res,400,{error:'invalid-google-drive-scope'});
      const id = base64url(crypto.randomBytes(18)), pollToken = base64url(crypto.randomBytes(32)), state = base64url(crypto.randomBytes(32));
      const verifier = base64url(crypto.randomBytes(48));
      const browserToken = base64url(crypto.randomBytes(32));
      const item = { id, pollHash:sha256(pollToken), browserHash:sha256(browserToken), callbackHash:'', callbackCookie:'', state, verifier, version, scope:requestedScope, status:'waiting', error:null, createdAt:Date.now(), updatedAt:Date.now(), result:null };
      sessions.set(id,item);
      const launch = new URL(`${PUBLIC_URL}/v1/google/authorize`);
      launch.searchParams.set('session', id);
      launch.searchParams.set('binding', browserToken);
      return json(res, 201, { id, pollToken, authUrl:launch.toString(), scope:requestedScope, expiresAt:Date.now()+SESSION_TTL_MS });
    }

    if (req.method === 'GET' && url.pathname === '/v1/google/authorize') {
      const id = String(url.searchParams.get('session') || '');
      const binding = String(url.searchParams.get('binding') || '');
      const item = sessions.get(id);
      if (!item || item.status !== 'waiting' || !safeEqual(item.browserHash, sha256(binding))) {
        return html(res, 400, 'Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', false);
      }
      const callbackToken = base64url(crypto.randomBytes(32));
      item.callbackHash = sha256(callbackToken);
      item.callbackCookie = newOAuthBrowserCookie();
      item.updatedAt = Date.now();
      const maxAge = Math.max(1, Math.ceil((item.createdAt + SESSION_TTL_MS - Date.now()) / 1000));
      res.writeHead(303, {
        Location: googleAuthorizationUrl(item).toString(),
        'Cache-Control':'no-store',
        'Referrer-Policy':'no-referrer',
        'X-Content-Type-Options':'nosniff',
        'Set-Cookie':`${item.callbackCookie}=${callbackToken}; Secure; HttpOnly; SameSite=Lax; Path=/v1/google/callback; Max-Age=${maxAge}`,
      });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/v1/google/callback') {
      const state = String(url.searchParams.get('state') || '');
      const item = [...sessions.values()].find((entry) => entry && safeEqual(entry.state, state));
      if (!item) return html(res, 400, 'Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', false);
      const callbackToken = cookieValue(req, item.callbackCookie);
      if (!item.callbackHash || !callbackToken || !safeEqual(item.callbackHash, sha256(callbackToken))) {
        return html(res, 400, 'Navigateur non reconnu', 'Cette autorisation OAuth doit revenir dans le même navigateur qui a démarré la connexion.', false);
      }
      if (item.status !== 'waiting') return html(res, 409, 'Connexion déjà traitée', 'Revenez à Direct-Xfer.', item.status === 'completed');
      const providerError = String(url.searchParams.get('error') || '');
      if (providerError) { item.status='error'; item.error=providerError === 'access_denied' ? 'oauth-access-denied' : 'oauth-provider-error'; item.updatedAt=Date.now(); return html(res,400,'Connexion annulée','Google n’a pas autorisé l’accès.',true); }
      const code = String(url.searchParams.get('code') || '');
      if (!code || code.length > 8192) { item.status='error'; item.error='oauth-code-missing'; item.updatedAt=Date.now(); return html(res,400,'Connexion incomplète','Google n’a pas renvoyé de code valide.',true); }
      item.status='exchanging'; item.updatedAt=Date.now();
      try {
        const token = await googleTokenRequest({ code, client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET, redirect_uri:`${PUBLIC_URL}/v1/google/callback`, grant_type:'authorization_code', code_verifier:item.verifier });
        if (!token.refresh_token) throw Object.assign(new Error('refresh-token-missing'), { code:'refresh-token-missing' });
        const cred = createCredential(String(token.refresh_token), String(token.scope || item.scope || GOOGLE_DRIVE_SCOPES.limited));
        item.result = {
          clientId:cred.id, clientSecret:cred.secret, tokenUrl:`${PUBLIC_URL}/v1/google/token`,
          token:{ access_token:String(token.access_token), token_type:String(token.token_type || 'Bearer'), refresh_token:cred.refreshHandle, scope:String(token.scope || item.scope || ''), expiry:new Date(Date.now()+Math.max(60,Number(token.expires_in)||3600)*1000).toISOString() },
        };
        item.status='completed'; item.updatedAt=Date.now();
        return html(res,200,'Google Drive connecté','L’autorisation est terminée. Revenez à Direct-Xfer.',true);
      } catch (error) {
        item.status='error'; item.error=String(error && error.code || 'oauth-token-exchange-failed').slice(0,120); item.updatedAt=Date.now();
        return html(res,500,'Connexion Google Drive échouée','Le service OAuth central n’a pas pu finaliser la connexion.',true);
      }
    }

    const sessionMatch = url.pathname.match(/^\/v1\/google\/sessions\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const item = sessions.get(sessionMatch[1]); const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
      if (!item || !safeEqual(item.pollHash, sha256(bearer))) return json(res,404,{error:'session-not-found'});
      return json(res,200,{ id:item.id, status:item.status, error:item.error, credential:item.status==='completed'?item.result:null, expiresAt:item.createdAt+SESSION_TTL_MS });
    }
    if (req.method === 'DELETE' && sessionMatch) {
      const item = sessions.get(sessionMatch[1]); const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
      if (!item || !safeEqual(item.pollHash, sha256(bearer))) return json(res,404,{error:'session-not-found'});
      sessions.delete(item.id); return json(res,200,{ok:true});
    }

    if (req.method === 'POST' && url.pathname === '/v1/google/token') {
      if (!allowRate(req, 'google-token', 240, 60 * 60 * 1000)) return json(res,429,{error:'rate_limited'});
      const form = await parseForm(req); const basic = parseBasicAuth(req);
      const grantType = String(form.get('grant_type') || '');
      const clientId = String((basic && basic.id) || form.get('client_id') || '');
      const clientSecret = String((basic && basic.secret) || form.get('client_secret') || '');
      const refreshHandle = String(form.get('refresh_token') || '');
      if (grantType !== 'refresh_token') return json(res,400,{error:'unsupported_grant_type'});
      const credential = getCredential(clientId, clientSecret, refreshHandle);
      if (!credential) return json(res,401,{error:'invalid_client'});
      try {
        const token = await googleTokenRequest({ client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET, refresh_token:decryptText(credential.googleRefreshToken), grant_type:'refresh_token' });
        const now = Date.now();
        credential.lastUsedAt=now;
        credential.expiresAt=now + CREDENTIAL_TTL_MS;
        saveStore();
        return json(res,200,{ access_token:String(token.access_token), token_type:String(token.token_type || 'Bearer'), expires_in:Math.max(60,Number(token.expires_in)||3600), scope:String(token.scope || credential.scope || ''), refresh_token:refreshHandle });
      } catch (error) {
        const code = String(error && error.code || 'token_refresh_failed').slice(0,120);
        if (code === 'invalid_grant') {
          delete store.credentials[clientId];
          saveStore();
          return json(res,400,{error:'invalid_grant'});
        }
        if (code === 'temporarily_unavailable') return json(res,503,{error:code});
        if (code === 'invalid_client') return json(res,503,{error:'broker_google_invalid_client'});
        return json(res,502,{error:code});
      }
    }

    return json(res,404,{error:'not-found'});
  } catch (error) {
    const code = String(error && error.code || error && error.message || 'broker-error');
    return json(res, code === 'body-too-large' ? 413 : 400, { error:code.slice(0,120) });
  }
}

function start() {
  const server = http.createServer(handle);
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  server.listen(PORT, HOST, () => {
    // Do not echo environment-derived host, port, public URL or credential state.
    // Container/orchestrator metadata already exposes the bound port when needed.
    console.log('[Direct-Xfer OAuth Broker] ready');
  });
  return server;
}
if (require.main === module) start();
module.exports = { handle, start, publicInfo };
