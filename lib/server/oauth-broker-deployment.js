'use strict';

const fs = require('fs');
const path = require('path');

const CF_API = 'https://api.cloudflare.com/client/v4';
const SCRIPT_NAME = 'direct-xfer-oauth-broker';
const DB_NAME = 'direct-xfer-oauth-broker';
const SESSION_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'assets', 'oauth-broker-worker.mjs'), 'utf8');
const DB_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'assets', 'oauth-broker-schema.sql'), 'utf8');

function createOAuthBrokerDeploymentRoutes(deps) {
  const { adminRouter, requireFullAdmin, crypto, auditReq } = deps;
  const sessions = new Map();
  const owner = (req) => String(req && req.session && req.session.accountId || '');

  function cleanupSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, item] of sessions) {
      if (!item || item.updatedAt < cutoff) sessions.delete(id);
    }
  }
  setInterval(cleanupSessions, 60 * 1000).unref();

  function makeError(code, status = 400, detail = '') {
    const error = new Error(code);
    error.code = code;
    error.status = status;
    error.detail = String(detail || '').slice(0, 500);
    return error;
  }

  function cleanToken(value) {
    const token = String(value || '').trim();
    if (token.length < 20 || token.length > 4096 || /\s/.test(token)) throw makeError('cloudflare-token-invalid', 400);
    return token;
  }

  function cleanAccountId(value) {
    const accountId = String(value || '').trim();
    if (!accountId) return '';
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw makeError('cloudflare-account-id-invalid', 400);
    return accountId;
  }

  function cfMessage(data, fallback) {
    const items = data && Array.isArray(data.errors) ? data.errors : [];
    const messages = data && Array.isArray(data.messages) ? data.messages : [];
    const parts = [...items, ...messages].map((item) => {
      if (!item || typeof item !== 'object') return '';
      const code = item.code == null ? '' : `#${String(item.code)} `;
      const message = typeof item.message === 'string' ? item.message : (item.message && typeof item.message === 'object' ? JSON.stringify(item.message) : '');
      return `${code}${message}`.trim();
    }).filter(Boolean);
    return (parts.join('; ') || fallback || 'cloudflare-api-error').slice(0, 500);
  }

  function stageError(error, stage) {
    const err = error instanceof Error ? error : makeError('oauth-broker-auto-failed', 500, String(error || ''));
    if (!err.stage) err.stage = String(stage || 'unknown');
    if (!err.detail) {
      const raw = String(err.message || '').trim();
      if (raw && raw !== err.code) err.detail = raw.slice(0, 500);
    }
    return err;
  }

  async function atStage(stage, fn) {
    try { return await fn(); }
    catch (error) { throw stageError(error, stage); }
  }

  async function cfFetch(token, pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      const headers = { authorization:`Bearer ${token}`, accept:'application/json', ...(options.headers || {}) };
      let body = options.body;
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.json);
      }
      const response = await fetch(`${CF_API}${pathname}`, { method:options.method || 'GET', headers, body, signal:controller.signal });
      let data = null;
      const contentType = String(response.headers.get('content-type') || '');
      if (contentType.includes('application/json')) {
        try { data = await response.json(); } catch (_) {}
      } else {
        try { data = await response.text(); } catch (_) {}
      }
      if (!response.ok || (data && typeof data === 'object' && data.success === false)) {
        const detail = typeof data === 'object' ? cfMessage(data, `Cloudflare HTTP ${response.status}`) : `Cloudflare HTTP ${response.status}`;
        const err = makeError('cloudflare-api-error', response.status === 401 || response.status === 403 ? 403 : 502, detail);
        err.cloudflareStatus = response.status;
        err.cloudflareData = data;
        throw err;
      }
      return data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : data;
    } catch (error) {
      if (error && error.name === 'AbortError') throw makeError('cloudflare-timeout', 504);
      if (error && error.code) throw error;
      throw makeError('cloudflare-network-error', 502, String(error && error.message || error || 'fetch failed'));
    } finally { clearTimeout(timer); }
  }

  async function verifyToken(token, requestedAccountId) {
    let result;
    try { result = await cfFetch(token, '/user/tokens/verify'); }
    catch (error) {
      const accountId = cleanAccountId(requestedAccountId);
      if (!accountId || !(error && (error.cloudflareStatus === 401 || error.cloudflareStatus === 403))) throw error;
      result = await cfFetch(token, `/accounts/${accountId}/tokens/verify`);
    }
    const status = String(result && result.status || '').toLowerCase();
    if (status && status !== 'active') throw makeError('cloudflare-token-inactive', 403, `Token status: ${status}`);
    return true;
  }

  async function detectAccount(token, requestedId) {
    const supplied = cleanAccountId(requestedId);
    if (supplied) return supplied;
    const discovered = new Map();
    let discoveryDetail = '';
    const collect = (items) => {
      for (const item of Array.isArray(items) ? items : []) {
        const account = item && item.account && typeof item.account === 'object' ? item.account : item;
        const id = String(account && account.id || '');
        if (/^[a-f0-9]{32}$/i.test(id)) discovered.set(id, { id, name:String(account && account.name || id).slice(0, 160) });
      }
    };
    try { collect(await cfFetch(token, '/accounts?per_page=50')); }
    catch (error) { discoveryDetail = String(error && error.detail || error && error.message || ''); }
    if (!discovered.size) {
      try { collect(await cfFetch(token, '/memberships?per_page=50&status=accepted')); }
      catch (error) { if (!discoveryDetail) discoveryDetail = String(error && error.detail || error && error.message || ''); }
    }
    const accounts = [...discovered.values()];
    if (accounts.length === 1) return accounts[0].id;
    if (accounts.length > 1) {
      const err = makeError('cloudflare-account-selection-required', 409);
      err.accounts = accounts.slice(0, 50);
      throw err;
    }
    throw makeError('cloudflare-account-id-required', 400, discoveryDetail || 'Cloudflare did not expose an account ID to this API token. Paste the 32-character Account ID and retry.');
  }

  async function ensureWorkersSubdomain(token, accountId) {
    try {
      const result = await cfFetch(token, `/accounts/${accountId}/workers/subdomain`);
      const existing = String(result && result.subdomain || '').trim().toLowerCase();
      if (existing) return existing;
    } catch (error) {
      if (!(error && error.cloudflareStatus === 404)) throw error;
    }
    for (let i = 0; i < 5; i += 1) {
      const suffix = crypto.randomBytes(4).toString('hex');
      const candidate = `direct-xfer-${accountId.slice(0, 6)}-${suffix}`.toLowerCase();
      try {
        const result = await cfFetch(token, `/accounts/${accountId}/workers/subdomain`, { method:'PUT', json:{ subdomain:candidate } });
        const created = String(result && result.subdomain || candidate).trim().toLowerCase();
        if (created) return created;
      } catch (error) {
        if (i === 4) throw error;
      }
    }
    throw makeError('cloudflare-workers-subdomain-failed', 502);
  }

  async function ensureDatabase(token, accountId) {
    let result = await cfFetch(token, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(DB_NAME)}&per_page=10`);
    let list = Array.isArray(result) ? result : [];
    let db = list.find((item) => item && String(item.name || '') === DB_NAME) || null;
    if (!db) db = await cfFetch(token, `/accounts/${accountId}/d1/database`, { method:'POST', json:{ name:DB_NAME } });
    const id = String(db && (db.uuid || db.id) || '');
    if (!id) throw makeError('cloudflare-d1-create-failed', 502);
    await cfFetch(token, `/accounts/${accountId}/d1/database/${encodeURIComponent(id)}/query`, { method:'POST', json:{ sql:DB_SCHEMA } });
    return id;
  }

  async function credentialCount(token, accountId, databaseId) {
    try {
      const result = await cfFetch(token, `/accounts/${accountId}/d1/database/${encodeURIComponent(databaseId)}/query`, { method:'POST', json:{ sql:'SELECT COUNT(*) AS count FROM credentials' } });
      const groups = Array.isArray(result) ? result : [];
      const row = groups[0] && Array.isArray(groups[0].results) ? groups[0].results[0] : null;
      return Math.max(0, Number(row && row.count || 0) || 0);
    } catch (_) { return 0; }
  }

  async function workerState(token, accountId, databaseId) {
    let secrets = [];
    let exists = false;
    try {
      const result = await cfFetch(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`);
      exists = true;
      secrets = Array.isArray(result) ? result.map((item) => String(item && item.name || '')).filter(Boolean) : [];
    } catch (error) {
      if (!(error && error.cloudflareStatus === 404)) throw error;
    }
    if (!exists) return { exists:false, secrets:[], d1Matches:false };
    let d1Matches = false;
    try {
      const settings = await cfFetch(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/settings`);
      const bindings = settings && Array.isArray(settings.bindings) ? settings.bindings : [];
      d1Matches = bindings.some((binding) => binding && binding.type === 'd1' && binding.name === 'DB' && String(binding.database_id || binding.id || '') === databaseId);
    } catch (_) {}
    return { exists:true, secrets, d1Matches };
  }

  function uploadForm(databaseId, includeBindings, secrets = null) {
    const metadata = { main_module:'index.js', compatibility_date:'2025-04-01' };
    if (includeBindings) {
      metadata.bindings = [{ type:'d1', name:'DB', database_id:databaseId }];
      if (secrets) {
        metadata.bindings.push(
          { type:'secret_text', name:'BROKER_DATA_KEY', text:secrets.dataKey },
          { type:'secret_text', name:'GOOGLE_CLIENT_ID', text:secrets.googleId },
          { type:'secret_text', name:'GOOGLE_CLIENT_SECRET', text:secrets.googleSecret },
        );
      }
    }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type:'application/json' }), 'metadata.json');
    form.append('index.js', new Blob([WORKER_SOURCE], { type:'application/javascript+module' }), 'index.js');
    return form;
  }

  async function uploadWorker(token, accountId, databaseId, state, count) {
    if (state.exists && state.d1Matches) {
      await cfFetch(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/content`, { method:'PUT', body:uploadForm(databaseId, false) });
      return state;
    }
    // Never overwrite an existing Worker whose D1 binding does not identify it
    // as the Direct-Xfer broker. A fixed name is convenient, but not sufficient
    // proof that the resource belongs to us.
    if (state.exists) throw makeError('cloudflare-worker-binding-conflict', 409);
    const bootstrap = {
      dataKey:crypto.randomBytes(48).toString('base64'),
      googleId:'bootstrap.disabled.apps.googleusercontent.com',
      googleSecret:'bootstrap.disabled',
    };
    await cfFetch(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`, { method:'PUT', body:uploadForm(databaseId, true, bootstrap), timeoutMs:60000 });
    return { exists:true, d1Matches:true, secrets:['BROKER_DATA_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'] };
  }

  async function putSecret(token, accountId, name, text) {
    await cfFetch(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`, { method:'PUT', json:{ type:'secret_text', name, text } });
  }

  async function ensureWorkerSecrets(token, accountId, state, count) {
    const names = new Set(state.secrets || []);
    if (!names.has('BROKER_DATA_KEY')) {
      if (count > 0) throw makeError('cloudflare-broker-data-key-missing', 409);
      await putSecret(token, accountId, 'BROKER_DATA_KEY', crypto.randomBytes(48).toString('base64'));
      names.add('BROKER_DATA_KEY');
    }
    if (!names.has('GOOGLE_CLIENT_ID')) await putSecret(token, accountId, 'GOOGLE_CLIENT_ID', 'bootstrap.disabled.apps.googleusercontent.com');
    if (!names.has('GOOGLE_CLIENT_SECRET')) await putSecret(token, accountId, 'GOOGLE_CLIENT_SECRET', 'bootstrap.disabled');
  }

  async function enableWorker(token, accountId) {
    await cfFetch(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/subdomain`, { method:'POST', json:{ enabled:true, previews_enabled:false } });
  }

  async function brokerInfo(url, attempts = 10) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${url}/v1/info`, { headers:{ accept:'application/json', 'cache-control':'no-cache' }, signal:controller.signal });
        const data = await response.json().catch(() => null);
        if (response.ok && data && data.service === 'direct-xfer-oauth-broker') return data;
        lastError = makeError('oauth-broker-unreachable', 502);
      } catch (error) {
        lastError = error && error.name === 'AbortError' ? makeError('oauth-broker-unreachable', 504, 'Broker health check timed out') : makeError('oauth-broker-unreachable', 502, String(error && error.message || error || 'Broker health check failed'));
      } finally { clearTimeout(timer); }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(3000, 750 + attempt * 250)));
    }
    throw lastError || makeError('oauth-broker-unreachable', 502);
  }

  async function waitForGoogleBrokerReady(url, attempts = 18) {
    let lastInfo = null;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const info = await brokerInfo(url, 1);
        lastInfo = info;
        if (info && info.google === true && info.storage === true) return info;
        lastError = makeError(
          'oauth-broker-google-propagation-pending',
          504,
          `Broker reachable but Google OAuth is not active yet (google=${!!(info && info.google)}, storage=${!!(info && info.storage)}). Cloudflare may still be propagating the new Worker secrets.`
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(3000, 1000 + attempt * 250)));
    }
    if (lastError && lastError.code === 'oauth-broker-google-propagation-pending') {
      lastError.detail = `Google OAuth secrets were accepted by Cloudflare, but the public broker still reports google=${!!(lastInfo && lastInfo.google)}, storage=${!!(lastInfo && lastInfo.storage)} after the propagation retry window.`;
    }
    throw lastError || makeError('oauth-broker-google-propagation-timeout', 504, 'Google OAuth secrets did not become active on the public broker in time.');
  }

  function sendError(res, error) {
    const code = String(error && error.code || 'oauth-broker-auto-failed');
    const status = Number(error && error.status) || 500;
    const payload = { error:code };
    if (error && error.detail) payload.detail = String(error.detail).slice(0, 500);
    if (error && error.stage) payload.stage = String(error.stage).slice(0, 80);
    if (error && error.cloudflareStatus) payload.cloudflareStatus = Number(error.cloudflareStatus) || undefined;
    if (error && Array.isArray(error.accounts)) payload.accounts = error.accounts;
    res.status(status).json(payload);
  }

  adminRouter.post('/storage/oauth/broker-auto/prepare', requireFullAdmin, async (req, res) => {
    try {
      cleanupSessions();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const token = cleanToken(body.apiToken);
      await atStage('token-verify', () => verifyToken(token, body.accountId));
      const accountId = await atStage('account-detect', () => detectAccount(token, body.accountId));
      const subdomain = await atStage('workers-subdomain', () => ensureWorkersSubdomain(token, accountId));
      const databaseId = await atStage('d1-database', () => ensureDatabase(token, accountId));
      const count = await atStage('d1-credentials-check', () => credentialCount(token, accountId, databaseId));
      let state = await atStage('worker-inspect', () => workerState(token, accountId, databaseId));
      state = await atStage('worker-upload', () => uploadWorker(token, accountId, databaseId, state, count));
      await atStage('worker-secrets', () => ensureWorkerSecrets(token, accountId, state, count));
      await atStage('worker-enable', () => enableWorker(token, accountId));
      const brokerUrl = `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;
      const info = await atStage('broker-health', () => brokerInfo(brokerUrl));
      const deploymentId = crypto.randomBytes(24).toString('hex');
      sessions.set(deploymentId, { ownerId:owner(req), token, accountId, databaseId, brokerUrl, callbackUrl:`${brokerUrl}/v1/google/callback`, updatedAt:Date.now() });
      auditReq(req, 'oauth-broker-cloudflare-prepared', brokerUrl);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok:true, deploymentId, accountId, brokerUrl, callbackUrl:`${brokerUrl}/v1/google/callback`, storage:!!info.storage, google:!!info.google });
    } catch (error) { sendError(res, error); }
  });

  adminRouter.post('/storage/oauth/broker-auto/google', requireFullAdmin, async (req, res) => {
    try {
      cleanupSessions();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const deploymentId = String(body.deploymentId || '');
      const session = sessions.get(deploymentId);
      if (!session || session.ownerId !== owner(req)) throw makeError('oauth-broker-deployment-expired', 404);
      const clientId = String(body.clientId || '').trim();
      const clientSecret = String(body.clientSecret || '').trim();
      if (!/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw makeError('oauth-google-client-id-invalid', 400);
      if (clientSecret.length < 12 || clientSecret.length > 4096) throw makeError('oauth-google-client-secret-invalid', 400);
      const count = await atStage('d1-credentials-check', () => credentialCount(session.token, session.accountId, session.databaseId));
      const infoBefore = await brokerInfo(session.brokerUrl).catch(() => null);
      if (count > 0 && infoBefore && infoBefore.google && body.replaceExisting !== true) throw makeError('oauth-broker-google-replace-confirm-required', 409);
      await atStage('google-client-id-secret', () => putSecret(session.token, session.accountId, 'GOOGLE_CLIENT_ID', clientId));
      await atStage('google-client-secret', () => putSecret(session.token, session.accountId, 'GOOGLE_CLIENT_SECRET', clientSecret));
      const info = await atStage('google-propagation', () => waitForGoogleBrokerReady(session.brokerUrl));
      sessions.delete(deploymentId);
      auditReq(req, 'oauth-broker-cloudflare-ready', session.brokerUrl);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok:true, brokerUrl:session.brokerUrl, callbackUrl:session.callbackUrl, google:true, storage:true });
    } catch (error) { sendError(res, error); }
  });

  adminRouter.post('/storage/oauth/broker-auto/cancel', requireFullAdmin, (req, res) => {
    const deploymentId = String(req.body && req.body.deploymentId || '');
    const session = sessions.get(deploymentId);
    if (session && session.ownerId === owner(req)) sessions.delete(deploymentId);
    res.json({ ok:true });
  });
}

module.exports = { createOAuthBrokerDeploymentRoutes, SCRIPT_NAME, DB_NAME };
