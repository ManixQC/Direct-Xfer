'use strict';

const { assertAsvsL3OutboundUrl } = require('./server/asvs-l3-policy');

const GOOGLE_DRIVE_SCOPE_MAP = Object.freeze({
  limited:'https://www.googleapis.com/auth/drive.file',
  readonly:'https://www.googleapis.com/auth/drive.readonly',
  full:'https://www.googleapis.com/auth/drive',
});
function normalizeGoogleDriveScope(value, fallback = GOOGLE_DRIVE_SCOPE_MAP.limited) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  for (const [mode, uri] of Object.entries(GOOGLE_DRIVE_SCOPE_MAP)) {
    if (raw === mode || raw === uri || raw === uri.replace('https://www.googleapis.com/auth/', '')) return uri;
  }
  return '';
}
function googleDriveScopeMode(value) {
  const uri = normalizeGoogleDriveScope(value, '');
  return Object.keys(GOOGLE_DRIVE_SCOPE_MAP).find((key) => GOOGLE_DRIVE_SCOPE_MAP[key] === uri) || '';
}

function cleanBrokerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(raw);
  const local = url.protocol === 'http:' && ['localhost','127.0.0.1','::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw Object.assign(new Error('oauth-broker-https-required'), { code:'oauth-broker-https-required' });
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw Object.assign(new Error('oauth-broker-url-invalid'), { code:'oauth-broker-url-invalid' });
  return url.origin;
}

class GoogleOAuthBrokerClient {
  constructor(options = {}) {
    this.asvsL3Mode = options.asvsL3Mode === true;
    this.asvsL3EgressAllowlist = String(options.asvsL3EgressAllowlist || '');
    this.baseUrl = cleanBrokerUrl(options.baseUrl == null ? process.env.DIRECT_XFER_OAUTH_BROKER_URL || '' : options.baseUrl);
    if (this.baseUrl) assertAsvsL3OutboundUrl(this.baseUrl, { enabled:this.asvsL3Mode, allowlist:this.asvsL3EgressAllowlist, allowHttpLoopback:true });
    this.fetch = options.fetch || globalThis.fetch;
    this.version = String(options.version || '1.67.35');
    this.timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);
  }
  configured() { return !!this.baseUrl; }
  setBaseUrl(value) { const next = cleanBrokerUrl(value); if (next) assertAsvsL3OutboundUrl(next, { enabled:this.asvsL3Mode, allowlist:this.asvsL3EgressAllowlist, allowHttpLoopback:true }); this.baseUrl = next; return this.baseUrl; }
  forBaseUrl(value) {
    return new GoogleOAuthBrokerClient({ baseUrl:value, fetch:this.fetch, version:this.version, timeoutMs:this.timeoutMs, asvsL3Mode:this.asvsL3Mode, asvsL3EgressAllowlist:this.asvsL3EgressAllowlist });
  }
  async _request(pathname, options = {}) {
    if (!this.baseUrl) throw Object.assign(new Error('oauth-broker-not-configured'), { code:'oauth-broker-not-configured' });
    if (typeof this.fetch !== 'function') throw Object.assign(new Error('fetch-unavailable'), { code:'oauth-broker-unreachable' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || this.timeoutMs));
    try {
      assertAsvsL3OutboundUrl(`${this.baseUrl}${pathname}`, { enabled:this.asvsL3Mode, allowlist:this.asvsL3EgressAllowlist, allowHttpLoopback:true });
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        ...options,
        signal:controller.signal,
        redirect:'error',
        headers:{ Accept:'application/json', ...(options.headers || {}) },
      });
      const maxBytes = Math.max(4096, Math.min(1024 * 1024, Number(options.maxBytes) || 256 * 1024));
      const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') || 0 : 0);
      if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('oauth-broker-response-too-large'), { code:'oauth-broker-response-invalid' });
      let text = '';
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch (_) {}
            throw Object.assign(new Error('oauth-broker-response-too-large'), { code:'oauth-broker-response-invalid' });
          }
          text += decoder.decode(value, { stream:true });
        }
        text += decoder.decode();
      } else if (typeof response.text === 'function') {
        text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) throw Object.assign(new Error('oauth-broker-response-too-large'), { code:'oauth-broker-response-invalid' });
      }
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = null; }
      }
      if (!response.ok) {
        const code = String(data && data.error || (response.status === 429 ? 'oauth-broker-rate-limited' : 'oauth-broker-request-failed'));
        const error = Object.assign(new Error(code), { code, status:response.status });
        throw error;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('oauth-broker-response-invalid'), { code:'oauth-broker-response-invalid' });
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') throw Object.assign(new Error('oauth-broker-timeout'), { code:'oauth-broker-timeout' });
      if (error && error.code) throw error;
      throw Object.assign(new Error('oauth-broker-unreachable'), { code:'oauth-broker-unreachable', cause:error });
    } finally { clearTimeout(timer); }
  }

  async info() {
    const data = await this._request('/v1/info', { method:'GET', maxBytes:64 * 1024 });
    const callbackUrl = String(data.callbackUrl || '');
    let callbackValid = false;
    try {
      callbackValid = new URL(callbackUrl).toString() === new URL(`${this.baseUrl}/v1/google/callback`).toString();
    } catch (_) {}
    return {
      available:data.service === 'direct-xfer-oauth-broker' && data.google === true && callbackValid,
      callbackUrl:callbackValid ? callbackUrl : '',
      version:String(data.version || ''),
      storage:data.storage !== false,
    };
  }
  async createSession(options = {}) {
    const requestedScope = normalizeGoogleDriveScope(options.scope);
    if (!requestedScope) throw Object.assign(new Error('invalid-google-drive-scope'), { code:'invalid-google-drive-scope' });
    const data = await this._request('/v1/google/sessions', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ version:this.version, scope:requestedScope }),
    });
    const id = String(data.id || ''), pollToken = String(data.pollToken || ''), authUrl = String(data.authUrl || '');
    const returnedScope = normalizeGoogleDriveScope(data.scope);
    if (returnedScope !== requestedScope) {
      throw Object.assign(new Error('oauth-broker-scope-upgrade-required'), { code:'oauth-broker-scope-upgrade-required' });
    }
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(id) || pollToken.length < 20) throw Object.assign(new Error('oauth-broker-response-invalid'), { code:'oauth-broker-response-invalid' });
    let auth; try { auth = new URL(authUrl); } catch (_) { throw Object.assign(new Error('oauth-broker-response-invalid'), { code:'oauth-broker-response-invalid' }); }
    const expiresAt = Number(data.expiresAt) || 0;
    let expectedLaunch; try { expectedLaunch = new URL(`${this.baseUrl}/v1/google/authorize`); } catch (_) { expectedLaunch = null; }
    const sessionId = String(auth.searchParams.get('session') || '');
    const binding = String(auth.searchParams.get('binding') || '');
    if (
      !expectedLaunch || auth.origin !== expectedLaunch.origin || auth.pathname !== expectedLaunch.pathname ||
      auth.username || auth.password || auth.hash ||
      sessionId !== id || binding.length < 20 || binding.length > 512 ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 30 * 60 * 1000
    ) throw Object.assign(new Error('oauth-broker-response-invalid'), { code:'oauth-broker-response-invalid' });
    // The browser first visits the broker launch endpoint. The broker binds the
    // OAuth transaction to that user-agent with an HttpOnly SameSite cookie, then
    // redirects to Google's S256-PKCE authorization endpoint. This prevents a
    // stolen state value from being completed in another browser session.
    return { id, pollToken, authUrl:auth.toString(), scope:requestedScope, expiresAt };
  }
  async poll(session) {
    const id = String(session && session.id || ''), pollToken = String(session && session.pollToken || '');
    if (!id || !pollToken) throw Object.assign(new Error('oauth-broker-session-invalid'), { code:'oauth-broker-session-invalid' });
    const data = await this._request(`/v1/google/sessions/${encodeURIComponent(id)}`, { method:'GET', headers:{ Authorization:`Bearer ${pollToken}` } });
    const status = String(data.status || '');
    if (!['waiting','exchanging','completed','error'].includes(status)) throw Object.assign(new Error('oauth-broker-response-invalid'), { code:'oauth-broker-response-invalid' });
    return { id, status, error:data.error ? String(data.error) : null, credential:data.credential || null };
  }
  async consume(session) {
    const id = String(session && session.id || ''), pollToken = String(session && session.pollToken || '');
    if (!id || !pollToken) return;
    try { await this._request(`/v1/google/sessions/${encodeURIComponent(id)}`, { method:'DELETE', headers:{ Authorization:`Bearer ${pollToken}` } }); } catch (_) {}
  }
  validateCredential(value, options = {}) {
    const data = value && typeof value === 'object' ? value : null;
    const expectedScope = normalizeGoogleDriveScope(options.scope);
    if (!expectedScope) throw Object.assign(new Error('invalid-google-drive-scope'), { code:'invalid-google-drive-scope' });
    const clientId = String(data && data.clientId || '').trim();
    const clientSecret = String(data && data.clientSecret || '').trim();
    const tokenUrl = String(data && data.tokenUrl || '').trim();
    const token = data && data.token && typeof data.token === 'object' ? data.token : null;
    if (!clientId.startsWith('dxc_') || clientId.length > 256 || clientSecret.length < 20 || clientSecret.length > 512) throw Object.assign(new Error('oauth-broker-credential-invalid'), { code:'oauth-broker-credential-invalid' });
    let parsed; try { parsed = new URL(tokenUrl); } catch (_) { throw Object.assign(new Error('oauth-broker-credential-invalid'), { code:'oauth-broker-credential-invalid' }); }
    const expectedTokenUrl = new URL(`${this.baseUrl}/v1/google/token`).toString();
    if (parsed.toString() !== expectedTokenUrl) throw Object.assign(new Error('oauth-broker-credential-invalid'), { code:'oauth-broker-credential-invalid' });
    const accessToken = String(token && token.access_token || '').trim();
    const refreshToken = String(token && token.refresh_token || '').trim();
    const expiry = String(token && token.expiry || '').trim();
    if (
      !token ||
      !accessToken || accessToken.length > 16384 ||
      !/^dxr_[A-Za-z0-9_-]{12,240}$/.test(refreshToken) ||
      (expiry && !Number.isFinite(Date.parse(expiry)))
    ) throw Object.assign(new Error('oauth-broker-credential-invalid'), { code:'oauth-broker-credential-invalid' });
    const grantedScopes = new Set(String(token.scope || '').split(/\s+/).filter(Boolean));
    if (!grantedScopes.has(expectedScope)) throw Object.assign(new Error('oauth-broker-scope-mismatch'), { code:'oauth-broker-scope-mismatch' });
    // A least-privilege session must never silently inherit the restricted full
    // Drive grant from an older authorization. The broker no longer enables
    // include_granted_scopes, and this client-side check enforces that invariant.
    if (expectedScope !== GOOGLE_DRIVE_SCOPE_MAP.full && grantedScopes.has(GOOGLE_DRIVE_SCOPE_MAP.full)) {
      throw Object.assign(new Error('oauth-broker-scope-mismatch'), { code:'oauth-broker-scope-mismatch' });
    }
    return { clientId, clientSecret, tokenUrl:parsed.toString(), scope:expectedScope, token:{ ...token, access_token:accessToken, refresh_token:refreshToken } };
  }
}

module.exports = { GoogleOAuthBrokerClient, cleanBrokerUrl, GOOGLE_DRIVE_SCOPE_MAP, normalizeGoogleDriveScope, googleDriveScopeMode };
