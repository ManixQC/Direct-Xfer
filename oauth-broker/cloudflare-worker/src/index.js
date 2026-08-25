const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LEGACY_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_SCOPE_MAP = Object.freeze({
  limited:'https://www.googleapis.com/auth/drive.file',
  readonly:'https://www.googleapis.com/auth/drive.readonly',
  full:'https://www.googleapis.com/auth/drive',
});

function normalizeDriveScope(value, fallback = DEFAULT_SCOPE) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  for (const [mode, uri] of Object.entries(DRIVE_SCOPE_MAP)) {
    if (raw === mode || raw === uri || raw === uri.replace('https://www.googleapis.com/auth/', '')) return uri;
  }
  return '';
}

function verifierPayload(raw) {
  const text = String(raw || '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const verifier = String(parsed.verifier || '');
      const scope = normalizeDriveScope(parsed.scope, '');
      const browserHash = String(parsed.browserHash || '');
      const callbackHash = String(parsed.callbackHash || '');
      const callbackCookie = String(parsed.callbackCookie || '');
      const state = String(parsed.state || '');
      if (verifier && scope) return { verifier, scope, browserHash, callbackHash, callbackCookie, state };
    }
  } catch {}
  // Sessions created by broker versions <= 1.67.29 stored only the PKCE verifier
  // and always requested the old full-Drive scope. Preserve those in-flight
  // callbacks while all new sessions default to drive.file.
  return { verifier:text, scope:LEGACY_SCOPE, browserHash:'', callbackHash:'', callbackCookie:'', state:'' };
}
const SESSION_TTL_MS = 15 * 60 * 1000;
const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

function html(title, message, status = 200, close = false, extraHeaders = {}) {
  const esc = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const nonce = b64url(randomBytes(18));
  const script = close
    ? `<script nonce="${nonce}">try{if(window.opener)window.opener.postMessage({type:'dx-oauth-broker-complete'},'*')}catch(_){}setTimeout(()=>window.close(),350)</script>`
    : '';
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:640px;padding:32px;text-align:center"><h1>${esc(title)}</h1><p>${esc(message)}</p></main>${script}</body></html>`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
      ...extraHeaders,
    },
  });
}


function newOAuthBrowserCookie() {
  return `__Host-dxo_${b64url(randomBytes(12))}`;
}
function cookieValue(request, name) {
  const raw = String(request.headers.get('cookie') || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1 || part.slice(0, idx).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return ''; }
  }
  return '';
}
function googleAuthorizationUrl(env, origin, state, verifier, scope) {
  const auth = new URL(GOOGLE_AUTH_URL);
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${origin}/v1/google/callback`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', scope);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('state', state);
  return sha256Bytes(verifier).then((digest) => {
    auth.searchParams.set('code_challenge', b64url(digest));
    auth.searchParams.set('code_challenge_method', 'S256');
    return auth;
  });
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function b64url(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textBytes(value) { return new TextEncoder().encode(String(value ?? '')); }
function bytesText(bytes) { return new TextDecoder().decode(bytes); }

async function sha256Bytes(value) {
  const source = value instanceof Uint8Array ? value : textBytes(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', source));
}
async function sha256(value) { return b64url(await sha256Bytes(value)); }

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function masterKey(env) {
  if (!env.BROKER_DATA_KEY || String(env.BROKER_DATA_KEY).length < 32) throw new Error('broker-data-key-missing');
  const material = await sha256Bytes(`Direct-Xfer\0OAuthBroker\0${env.BROKER_DATA_KEY}`);
  return crypto.subtle.importKey('raw', material, { name:'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptText(env, value) {
  const key = await masterKey(env);
  const iv = randomBytes(12);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, textBytes(value)));
  return `v1.${b64url(iv)}.${b64url(encrypted)}`;
}

async function decryptText(env, packed) {
  const parts = String(packed || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('credential-cipher-invalid');
  const key = await masterKey(env);
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromB64url(parts[1]) }, key, fromB64url(parts[2]));
  return bytesText(new Uint8Array(plain));
}

function requestIp(request) {
  return String(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 80);
}

async function rateLimit(env, request, bucket, limit, windowMs) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${bucket}:${await sha256(requestIp(request))}:${windowStart}`;
  await env.DB.prepare(`INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(bucket_key) DO UPDATE SET count=count+1`).bind(key, windowStart).run();
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket_key=?').bind(key).first();
  return Number(row?.count || 0) <= limit;
}

async function cleanup(env) {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM credentials WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(cutoff),
  ]);
}

function parseBasicAuth(request) {
  const raw = String(request.headers.get('authorization') || '');
  if (!/^Basic\s+/i.test(raw)) return null;
  try {
    const decoded = atob(raw.replace(/^Basic\s+/i, ''));
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { id:decodeURIComponent(decoded.slice(0, idx)), secret:decodeURIComponent(decoded.slice(idx + 1)) };
  } catch { return null; }
}

async function readTextLimited(request, max = 64 * 1024) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > max) throw Object.assign(new Error('body-too-large'), { status:413 });
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch {}
      throw Object.assign(new Error('body-too-large'), { status:413 });
    }
    text += decoder.decode(value, { stream:true });
  }
  text += decoder.decode();
  return text;
}

async function parseJson(request, max = 64 * 1024) {
  const text = await readTextLimited(request, max);
  if (!text) return {};
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-json');
  return body;
}

async function parseForm(request, max = 16 * 1024) {
  return new URLSearchParams(await readTextLimited(request, max));
}

async function googleTokenRequest(env, params) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded', accept:'application/json' },
    body:new URLSearchParams(params),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || !data || !data.access_token) {
    const code = String(data?.error || 'google-token-exchange-failed');
    const error = new Error(code);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function brokerOrigin(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','::1'].includes(url.hostname)) throw new Error('broker-https-required');
  return url.origin;
}

function googleConfigured(env) {
  return /^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(String(env.GOOGLE_CLIENT_ID || ''))
    && String(env.GOOGLE_CLIENT_SECRET || '').length >= 12
    && !String(env.GOOGLE_CLIENT_SECRET || '').startsWith('bootstrap.')
    && String(env.BROKER_DATA_KEY || '').length >= 32
    && !!env.DB;
}

async function storageReady(env) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('sessions','credentials','rate_limits')").first();
    return Number(row?.count || 0) === 3;
  } catch {
    return false;
  }
}

async function publicInfo(request, env) {
  const origin = brokerOrigin(request);
  const storage = await storageReady(env);
  return {
    service:'direct-xfer-oauth-broker',
    version:'2',
    runtime:'cloudflare-workers',
    google:googleConfigured(env) && storage,
    storage,
    callbackUrl:`${origin}/v1/google/callback`,
  };
}

async function createCredential(env, googleRefreshToken, scope) {
  const id = `dxc_${b64url(randomBytes(18))}`;
  const secret = b64url(randomBytes(32));
  const refreshHandle = `dxr_${b64url(randomBytes(24))}`;
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO credentials
    (id, secret_hash, refresh_hash, google_refresh_token_enc, scope, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, await sha256(secret), await sha256(refreshHandle), await encryptText(env, googleRefreshToken), String(scope || DEFAULT_SCOPE), now, now, now + CREDENTIAL_TTL_MS)
    .run();
  return { id, secret, refreshHandle };
}

async function getCredential(env, id, secret, refreshHandle) {
  const item = await env.DB.prepare('SELECT * FROM credentials WHERE id=? AND expires_at>?').bind(String(id || ''), Date.now()).first();
  if (!item) return null;
  if (!safeEqual(item.secret_hash, await sha256(secret)) || !safeEqual(item.refresh_hash, await sha256(refreshHandle))) return null;
  return item;
}

async function handleCreateSession(request, env) {
  if (!await rateLimit(env, request, 'google-session', 30, 60 * 60 * 1000)) return json({ error:'rate-limited' }, 429);
  const body = await parseJson(request);
  const version = String(body.version || '').slice(0, 64);
  const requestedScope = normalizeDriveScope(body.scope);
  if (!requestedScope) return json({ error:'invalid-google-drive-scope' }, 400);
  const id = b64url(randomBytes(18));
  const pollToken = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const browserToken = b64url(randomBytes(32));
  const browserHash = await sha256(browserToken);
  const origin = brokerOrigin(request);
  const callbackUrl = `${origin}/v1/google/callback`;
  const now = Date.now();

  await env.DB.prepare(`INSERT INTO sessions
    (id, poll_hash, state_hash, verifier_enc, version, status, error, callback_origin, result_enc, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'waiting', NULL, ?, NULL, ?, ?, ?)`)
    .bind(id, await sha256(pollToken), await sha256(state), await encryptText(env, JSON.stringify({ verifier, scope:requestedScope, browserHash, state })), version, origin, now, now, now + SESSION_TTL_MS)
    .run();

  const launch = new URL(`${origin}/v1/google/authorize`);
  launch.searchParams.set('session', id);
  launch.searchParams.set('binding', browserToken);
  return json({ id, pollToken, authUrl:launch.toString(), scope:requestedScope, expiresAt:now + SESSION_TTL_MS }, 201);
}

async function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const id = String(url.searchParams.get('session') || '');
  const binding = String(url.searchParams.get('binding') || '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id) || binding.length < 20 || binding.length > 512) {
    return html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', 400);
  }
  const item = await env.DB.prepare("SELECT * FROM sessions WHERE id=? AND status='waiting' AND expires_at>?").bind(id, Date.now()).first();
  if (!item) return html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', 400);
  const verifierData = verifierPayload(await decryptText(env, item.verifier_enc));
  if (!verifierData.browserHash || !safeEqual(verifierData.browserHash, await sha256(binding))) {
    return html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', 400);
  }
  const origin = String(item.callback_origin || brokerOrigin(request));
  if (!verifierData.state || !safeEqual(await sha256(verifierData.state), String(item.state_hash || ''))) return html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', 400);
  const callbackToken = b64url(randomBytes(32));
  const callbackCookie = newOAuthBrowserCookie();
  const callbackHash = await sha256(callbackToken);
  const updatedPayload = JSON.stringify({ ...verifierData, callbackHash, callbackCookie });
  const updated = await env.DB.prepare("UPDATE sessions SET verifier_enc=?, updated_at=? WHERE id=? AND status='waiting'")
    .bind(await encryptText(env, updatedPayload), Date.now(), id).run();
  if (Number(updated?.meta?.changes || 0) !== 1) return html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', 409);
  const auth = await googleAuthorizationUrl(env, origin, verifierData.state, verifierData.verifier, verifierData.scope);
  return new Response(null, { status:303, headers:{
    location:auth.toString(),
    'cache-control':'no-store',
    'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff',
    'set-cookie':`${callbackCookie}=${callbackToken}; Secure; HttpOnly; SameSite=Lax; Path=/v1/google/callback; Max-Age=${Math.max(1, Math.ceil((Number(item.expires_at) - Date.now()) / 1000))}`,
  }});
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const state = String(url.searchParams.get('state') || '');
  if (!state) return html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', 400);
  const stateHash = await sha256(state);
  const item = await env.DB.prepare('SELECT * FROM sessions WHERE state_hash=? AND expires_at>?').bind(stateHash, Date.now()).first();
  if (!item) return html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion.', 400);
  if (item.status !== 'waiting') return html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', 409, item.status === 'completed');
  const verifierDataForBinding = verifierPayload(await decryptText(env, item.verifier_enc));
  const callbackToken = cookieValue(request, verifierDataForBinding.callbackCookie);
  if (!verifierDataForBinding.callbackHash || !callbackToken || !safeEqual(verifierDataForBinding.callbackHash, await sha256(callbackToken))) {
    return html('Navigateur non reconnu', 'Cette autorisation OAuth doit revenir dans le même navigateur qui a démarré la connexion.', 400);
  }

  const providerError = String(url.searchParams.get('error') || '');
  if (providerError) {
    const errorCode = providerError === 'access_denied' ? 'oauth-access-denied' : 'oauth-provider-error';
    const updated = await env.DB.prepare("UPDATE sessions SET status='error', error=?, updated_at=? WHERE id=? AND status='waiting'")
      .bind(errorCode, Date.now(), item.id).run();
    if (Number(updated?.meta?.changes || 0) !== 1) return html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', 409);
    return html('Connexion annulée', 'Google n’a pas autorisé l’accès.', 400, true);
  }

  const code = String(url.searchParams.get('code') || '');
  if (!code || code.length > 8192) {
    const updated = await env.DB.prepare("UPDATE sessions SET status='error', error='oauth-code-missing', updated_at=? WHERE id=? AND status='waiting'")
      .bind(Date.now(), item.id).run();
    if (Number(updated?.meta?.changes || 0) !== 1) return html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', 409);
    return html('Connexion incomplète', 'Google n’a pas renvoyé de code valide.', 400, true);
  }

  // Claim the callback atomically. Cloudflare can execute two callback requests
  // concurrently; without the status guard a duplicate request could consume the
  // code twice and overwrite a successful session with invalid_grant.
  const claim = await env.DB.prepare("UPDATE sessions SET status='exchanging', updated_at=? WHERE id=? AND status='waiting'")
    .bind(Date.now(), item.id).run();
  if (Number(claim?.meta?.changes || 0) !== 1) return html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', 409);

  try {
    const origin = String(item.callback_origin || brokerOrigin(request));
    const verifierData = verifierPayload(await decryptText(env, item.verifier_enc));
    const token = await googleTokenRequest(env, {
      code,
      client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,
      redirect_uri:`${origin}/v1/google/callback`,
      grant_type:'authorization_code',
      code_verifier:verifierData.verifier,
    });
    if (!token.refresh_token) throw Object.assign(new Error('refresh-token-missing'), { code:'refresh-token-missing' });

    const id = `dxc_${b64url(randomBytes(18))}`;
    const secret = b64url(randomBytes(32));
    const refreshHandle = `dxr_${b64url(randomBytes(24))}`;
    const now = Date.now();
    const result = {
      clientId:id,
      clientSecret:secret,
      tokenUrl:`${origin}/v1/google/token`,
      token:{
        access_token:String(token.access_token),
        token_type:String(token.token_type || 'Bearer'),
        refresh_token:refreshHandle,
        scope:String(token.scope || verifierData.scope),
        expiry:new Date(now + Math.max(60, Number(token.expires_in) || 3600) * 1000).toISOString(),
      },
    };
    const encryptedRefresh = await encryptText(env, String(token.refresh_token));
    const encryptedResult = await encryptText(env, JSON.stringify(result));
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO credentials
        (id, secret_hash, refresh_hash, google_refresh_token_enc, scope, created_at, last_used_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND status='exchanging')`)
        .bind(id, await sha256(secret), await sha256(refreshHandle), encryptedRefresh, String(token.scope || verifierData.scope), now, now, now + CREDENTIAL_TTL_MS, item.id),
      env.DB.prepare("UPDATE sessions SET status='completed', error=NULL, result_enc=?, updated_at=? WHERE id=? AND status='exchanging'")
        .bind(encryptedResult, now, item.id),
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1 || Number(results?.[1]?.meta?.changes || 0) !== 1) {
      return html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', 409);
    }
    return html('Google Drive connecté', 'L’autorisation est terminée. Revenez à Direct-Xfer.', 200, true);
  } catch (error) {
    const errorCode = String(error?.code || 'oauth-token-exchange-failed').slice(0, 120);
    await env.DB.prepare("UPDATE sessions SET status='error', error=?, updated_at=? WHERE id=? AND status='exchanging'")
      .bind(errorCode, Date.now(), item.id).run();
    return html('Connexion Google Drive échouée', 'Le service OAuth central n’a pas pu finaliser la connexion.', 500, true);
  }
}

async function handlePoll(request, env, id) {
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const item = await env.DB.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').bind(id, Date.now()).first();
  if (!item || !safeEqual(item.poll_hash, await sha256(bearer))) return json({ error:'session-not-found' }, 404);
  let credential = null;
  if (item.status === 'completed' && item.result_enc) {
    try { credential = JSON.parse(await decryptText(env, item.result_enc)); } catch { return json({ error:'session-result-corrupt' }, 500); }
  }
  return json({ id:item.id, status:item.status, error:item.error || null, credential, expiresAt:item.expires_at });
}

async function handleDeleteSession(request, env, id) {
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const item = await env.DB.prepare('SELECT id, poll_hash FROM sessions WHERE id=?').bind(id).first();
  if (!item || !safeEqual(item.poll_hash, await sha256(bearer))) return json({ error:'session-not-found' }, 404);
  await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(id).run();
  return json({ ok:true });
}

async function handleRefresh(request, env) {
  if (!await rateLimit(env, request, 'google-token', 240, 60 * 60 * 1000)) return json({ error:'rate_limited' }, 429);
  const form = await parseForm(request);
  const basic = parseBasicAuth(request);
  const grantType = String(form.get('grant_type') || '');
  const clientId = String(basic?.id || form.get('client_id') || '');
  const clientSecret = String(basic?.secret || form.get('client_secret') || '');
  const refreshHandle = String(form.get('refresh_token') || '');
  if (grantType !== 'refresh_token') return json({ error:'unsupported_grant_type' }, 400);
  const credential = await getCredential(env, clientId, clientSecret, refreshHandle);
  if (!credential) return json({ error:'invalid_client' }, 401);
  try {
    const token = await googleTokenRequest(env, {
      client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,
      refresh_token:await decryptText(env, credential.google_refresh_token_enc),
      grant_type:'refresh_token',
    });
    const now = Date.now();
    await env.DB.prepare('UPDATE credentials SET last_used_at=?, expires_at=? WHERE id=?').bind(now, now + CREDENTIAL_TTL_MS, clientId).run();
    return json({
      access_token:String(token.access_token),
      token_type:String(token.token_type || 'Bearer'),
      expires_in:Math.max(60, Number(token.expires_in) || 3600),
      scope:String(token.scope || credential.scope || ''),
      refresh_token:refreshHandle,
    });
  } catch (error) {
    const code = String(error?.code || 'token_refresh_failed').slice(0, 120);
    if (code === 'invalid_grant') {
      await env.DB.prepare('DELETE FROM credentials WHERE id=?').bind(clientId).run();
      return json({ error:'invalid_grant' }, 400);
    }
    if (code === 'temporarily_unavailable') return json({ error:code }, 503);
    if (code === 'invalid_client') return json({ error:'broker_google_invalid_client' }, 503);
    return json({ error:code }, 502);
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/v1/info')) return json(await publicInfo(request, env));
  if (!googleConfigured(env)) return json({ error:'broker-google-not-configured' }, 503);
  if (!await storageReady(env)) return json({ error:'broker-storage-not-ready' }, 503);
  await cleanup(env);
  if (request.method === 'POST' && url.pathname === '/v1/google/sessions') return handleCreateSession(request, env);
  if (request.method === 'GET' && url.pathname === '/v1/google/authorize') return handleAuthorize(request, env);
  if (request.method === 'GET' && url.pathname === '/v1/google/callback') return handleCallback(request, env);
  const match = url.pathname.match(/^\/v1\/google\/sessions\/([A-Za-z0-9_-]+)$/);
  if (match && request.method === 'GET') return handlePoll(request, env, match[1]);
  if (match && request.method === 'DELETE') return handleDeleteSession(request, env, match[1]);
  if (request.method === 'POST' && url.pathname === '/v1/google/token') return handleRefresh(request, env);
  return json({ error:'not-found' }, 404);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      const status = Number(error?.status) || (error?.message === 'body-too-large' ? 413 : 400);
      return json({ error:String(error?.code || error?.message || 'broker-error').slice(0, 120) }, status);
    }
  },
};
