'use strict';

const { assertAsvsL3OutboundUrl } = require('./asvs-l3-policy');

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
function googleDriveRcloneScope(value){
  const uri=normalizeGoogleDriveScope(value,'');
  if(uri===GOOGLE_DRIVE_SCOPES.limited)return 'drive.file';
  if(uri===GOOGLE_DRIVE_SCOPES.readonly)return 'drive.readonly';
  if(uri===GOOGLE_DRIVE_SCOPES.full)return 'drive';
  return '';
}

// First-time rclone remote configuration for the standard admin UI. The module
// owns short-lived state-machine/OAuth sessions so server.js stays a composition
// root and connector secrets never become part of persisted Direct-Xfer state.
function createStorageConnectorConfigRoutes(deps) {
  const {
    adminRouter, requireFullAdmin, storageConnectorService, googleOAuthProfileStore, googleOAuthBrokerClient, CONNECTOR_TYPES,
    OAUTH_CONNECTOR_TYPES, connectorBackendType, safeRcloneErrorDetail, crypto, isLoopback, clientIp,
    auditReq, logAudit, getAccountById, invalidateConnectorProbe, googleOAuthPublicOrigin, googleOAuthBrokerUrl, googleOAuthBrokerManaged,
    ASVS_L3_MODE = false, ASVS_L3_EGRESS_ALLOWLIST = '',
  } = deps;

  const sessions = new Map();
  const googleWebSessions = new Map();
  const ttlMs = 15 * 60 * 1000;
  let activeOAuthSessionId = '';
  const owner = (req) => String(req && req.session && req.session.accountId || '');
  const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  const browserSessionHash = (req) => {
    const sid = String(req && req.session && req.session.sid || '');
    return sid ? crypto.createHash('sha256').update('Direct-Xfer\0GoogleOAuthUA\0').update(sid).digest('hex') : '';
  };
  const safeHashEqual = (a, b) => {
    const aa = Buffer.from(String(a || ''), 'utf8'), bb = Buffer.from(String(b || ''), 'utf8');
    return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  };
  function requestOrigin(req) {
    try {
      const configured = typeof googleOAuthPublicOrigin === 'function' ? String(googleOAuthPublicOrigin() || '').trim() : '';
      if (configured) {
        const url = new URL(configured);
        if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password) return url.origin;
      }
    } catch (_) {}
    const proto = String(req && req.protocol || '').toLowerCase();
    const host = String(req && typeof req.get === 'function' && req.get('host') || '').trim();
    if (!host || /[\s\/\\]/.test(host)) return '';
    if (proto !== 'https' && proto !== 'http') return '';
    return `${proto}://${host}`;
  }
  function googleCallbackUrl(req) {
    const origin = requestOrigin(req);
    return origin ? `${origin}/api/storage/oauth/google/callback` : '';
  }
  function requestCanUseLoopbackOAuth(req) {
    const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
    if (isLoopback(ip)) return true;
    const candidates = [];
    try { if (req && typeof req.get === 'function') { candidates.push(req.get('host') || '', req.get('x-forwarded-host') || '', req.get('origin') || '', req.get('referer') || ''); } } catch (_) {}
    for (const raw of candidates) {
      if (!raw) continue;
      try {
        const value = /^[a-z]+:\/\//i.test(String(raw)) ? String(raw) : `http://${String(raw).split(',')[0].trim()}`;
        const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      } catch (_) {}
    }
    return false;
  }
  function currentBrokerUrl() {
    if (typeof googleOAuthBrokerUrl === 'function') {
      try { return String(googleOAuthBrokerUrl() || '').trim(); } catch (_) { return ''; }
    }
    return String(googleOAuthBrokerClient && googleOAuthBrokerClient.baseUrl || '').trim();
  }
  function currentBrokerClient() {
    if (!googleOAuthBrokerClient) return null;
    const url = currentBrokerUrl();
    if (typeof googleOAuthBrokerUrl !== 'function') return googleOAuthBrokerClient;
    if (!url) {
      if (!googleOAuthBrokerClient.baseUrl) return googleOAuthBrokerClient;
      return typeof googleOAuthBrokerClient.forBaseUrl === 'function' ? googleOAuthBrokerClient.forBaseUrl('') : googleOAuthBrokerClient;
    }
    if (String(googleOAuthBrokerClient.baseUrl || '') === url) return googleOAuthBrokerClient;
    return typeof googleOAuthBrokerClient.forBaseUrl === 'function' ? googleOAuthBrokerClient.forBaseUrl(url) : googleOAuthBrokerClient;
  }
  function brokerManaged() {
    try { return typeof googleOAuthBrokerManaged === 'function' ? !!googleOAuthBrokerManaged() : false; } catch (_) { return false; }
  }

  function cleanGoogleWebSessions() {
    const cutoff = Date.now() - ttlMs;
    for (const [id, item] of googleWebSessions) {
      if (item && item.updatedAt >= cutoff) continue;
      googleWebSessions.delete(id);
      const brokerClient = item && item.brokerClient || googleOAuthBrokerClient;
      if (item && item.broker && item.brokerSession && brokerClient && typeof brokerClient.consume === 'function') {
        void brokerClient.consume(item.brokerSession);
      }
    }
  }

  function clearOAuth(session) {
    if (!session) return;
    session.oauthAttempt = (Number(session.oauthAttempt) || 0) + 1;
    try { if (session.oauthHandle) session.oauthHandle.cancel(); } catch (_) {}
    session.oauthHandle = null;
    session.oauthTokenQuestion = null;
    session.authUrl = '';
    session.oauthCallbackRequired = false;
    if (activeOAuthSessionId === session.id) activeOAuthSessionId = '';
  }

  async function restartSession(session) {
    clearOAuth(session);
    session.status = 'working';
    session.error = null;
    session.updatedAt = Date.now();
    try { await storageConnectorService.deleteRemote(session.remote); } catch (error) {
      if (!error || error.code !== 'remote-not-found') throw error;
    }
    const question = await storageConnectorService.configCreateStart(session.remote, session.type, { parameters:session.parameters });
    session.all = !OAUTH_CONNECTOR_TYPES.has(session.type);
    finish(session, question);
    session.error = null;
    return session;
  }

  function sanitizeQuestion(question) {
    if (!question || question.done || !question.state) return null;
    const option = question.option && typeof question.option === 'object' ? question.option : {};
    const examples = Array.isArray(option.Examples) ? option.Examples.slice(0, 100).map((item) => ({
      value:String(item && item.Value == null ? '' : item.Value).slice(0, 4096),
      help:String(item && item.Help || '').slice(0, 500),
    })) : [];
    return {
      name:String(option.Name || '').slice(0, 120),
      help:String(option.Help || '').slice(0, 6000),
      default:option.Default == null ? '' : String(option.Default).slice(0, 4096),
      examples, required:!!option.Required, password:!!option.IsPassword,
      type:String(option.Type || 'string').slice(0, 40), exclusive:!!option.Exclusive,
      error:String(question.error || '').slice(0, 1000),
    };
  }

  function publicSession(req, session) {
    return {
      id:session.id, remote:session.remote, type:session.type, backend:session.backend,
      status:session.status, question:sanitizeQuestion(session.question), authUrl:session.authUrl || null,
      oauthCallbackRequired:!!session.oauthCallbackRequired,
      localBrowserLikely:isLoopback(String(clientIp(req) || '').replace(/^::ffff:/i, '')),
      error:session.error || null,
    };
  }

  function findSession(req, id) {
    const session = sessions.get(String(id || ''));
    if (!session || session.ownerId !== owner(req)) return null;
    if (Date.now() - session.updatedAt > ttlMs) return null;
    return session;
  }

  function finish(session, question) {
    session.question = question || { done:true, state:'', option:null };
    session.updatedAt = Date.now();
    session.status = session.question.done ? 'completed' : 'question';
    if (session.question.done) {
      invalidateConnectorProbe();
      setTimeout(() => sessions.delete(session.id), 2 * 60 * 1000).unref();
    }
  }

  function cleanup() {
    cleanGoogleWebSessions();
    const cutoff = Date.now() - ttlMs;
    for (const [id, session] of sessions) {
      if (!session || session.updatedAt >= cutoff) continue;
      sessions.delete(id);
      if (activeOAuthSessionId === id) activeOAuthSessionId = '';
      clearOAuth(session);
      if (session.status !== 'completed') void storageConnectorService.deleteRemote(session.remote).catch(() => {});
    }
  }
  setInterval(cleanup, 60 * 1000).unref();

  // Google Drive's automatic browser flow uses a Web-application OAuth client so
  // Google can redirect directly back to this Direct-Xfer instance. Legacy Desktop
  // credentials remain readable only for advanced/backward-compatible rclone flows.
  // The client secret is never returned to the browser after it is saved.
  adminRouter.get('/storage/oauth/google-profile', requireFullAdmin, (req, res) => {
    try {
      const status = googleOAuthProfileStore && typeof googleOAuthProfileStore.status === 'function'
        ? googleOAuthProfileStore.status()
        : { configured:false, source:'none', managed:false, clientIdHint:'', savedAt:0 };
      res.setHeader('Cache-Control', 'no-store');
      res.json(status);
    } catch (error) {
      res.status(500).json({ error:String(error && error.code || 'google-oauth-profile-invalid') });
    }
  });

  adminRouter.post('/storage/oauth/google-profile', requireFullAdmin, (req, res) => {
    if (!googleOAuthProfileStore || typeof googleOAuthProfileStore.save !== 'function') return res.status(501).json({ error:'google-oauth-profile-unavailable' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const status = googleOAuthProfileStore.save({ clientId:body.clientId, clientSecret:body.clientSecret, kind:body.kind || 'web' });
      auditReq(req, 'google-oauth-profile-saved', status.clientIdHint || '');
      res.setHeader('Cache-Control', 'no-store');
      res.json(status);
    } catch (error) {
      const code = String(error && error.code || 'google-oauth-profile-save-failed');
      const status = code === 'google-oauth-profile-managed' ? 409 : code.startsWith('oauth-google-client-') ? 400 : 500;
      res.status(status).json({ error:code });
    }
  });

  adminRouter.delete('/storage/oauth/google-profile', requireFullAdmin, (req, res) => {
    if (!googleOAuthProfileStore || typeof googleOAuthProfileStore.clear !== 'function') return res.status(501).json({ error:'google-oauth-profile-unavailable' });
    try {
      const status = googleOAuthProfileStore.clear();
      auditReq(req, 'google-oauth-profile-cleared', '');
      res.setHeader('Cache-Control', 'no-store');
      res.json(status);
    } catch (error) {
      const code = String(error && error.code || 'google-oauth-profile-clear-failed');
      res.status(code === 'google-oauth-profile-managed' ? 409 : 500).json({ error:code });
    }
  });


  adminRouter.get('/storage/oauth/google-web-info', requireFullAdmin, async (req, res) => {
    try {
      const callbackUrl = googleCallbackUrl(req);
      const profile = googleOAuthProfileStore && typeof googleOAuthProfileStore.get === 'function' ? googleOAuthProfileStore.get() : null;
      const brokerClient = currentBrokerClient();
      const brokerUrl = currentBrokerUrl();
      let broker = { configured:false, available:false, callbackUrl:'' };
      if (brokerClient && typeof brokerClient.configured === 'function' && brokerClient.configured()) {
        broker.configured = true;
        try { broker = { ...broker, ...(await brokerClient.info()) }; } catch (error) { broker.error = String(error && error.code || 'oauth-broker-unreachable'); }
      }
      let localRcloneFallback = false;
      if (!broker.available && !(profile && profile.clientId && profile.clientSecret && profile.kind === 'web')) {
        const sameHost = requestCanUseLoopbackOAuth(req);
        if (sameHost) {
          try { const caps = await storageConnectorService.capabilities(); localRcloneFallback = !!(caps && caps.available); } catch (_) {}
        }
      }
      const localWebReady = !!(profile && profile.clientId && profile.clientSecret && profile.kind === 'web');
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        configured:broker.available || localWebReady || localRcloneFallback,
        brokerConfigured:broker.configured, brokerAvailable:!!broker.available, brokerCallbackUrl:String(broker.callbackUrl || ''), brokerError:broker.error || null,
        brokerUrl, brokerManaged:brokerManaged(),
        localRcloneFallback,
        kind:broker.available ? 'broker' : (localWebReady ? 'web' : (localRcloneFallback ? 'rclone-local' : 'none')),
        managed:broker.available || !!(profile && profile.managed),
        callbackUrl:broker.available ? String(broker.callbackUrl || '') : callbackUrl,
        httpsRequired:broker.available || localRcloneFallback ? false : !!(callbackUrl && !callbackUrl.startsWith('https://') && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(callbackUrl)),
      });
    } catch (error) { res.status(500).json({ error:String(error && error.code || 'google-web-oauth-info-failed') }); }
  });

  adminRouter.post('/storage/remotes/google-oauth/start', requireFullAdmin, async (req, res) => {
    cleanup();
    const remote = String(req.body && req.body.remote || '').trim().replace(/:$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) return res.status(400).json({ error:'invalid-rclone-config' });
    const replace = req.body && req.body.replace === true;
    const requestedScope = normalizeGoogleDriveScope(req.body && req.body.scope);
    if (!requestedScope) return res.status(400).json({ error:'invalid-google-drive-scope' });
    try {
      const caps = await storageConnectorService.capabilities();
      if (!caps || !caps.available) return res.status(503).json({ error:'rclone-unavailable' });
      const existing = await storageConnectorService.configuredRemotes();
      if (existing.includes(remote) && !replace) {
        let existingInfo = null;
        try {
          if (storageConnectorService && typeof storageConnectorService.googleRemoteInfo === 'function') {
            existingInfo = await storageConnectorService.googleRemoteInfo(remote);
          }
        } catch (_) {}
        const configuredScope = String(existingInfo && existingInfo.configuredScope || requestedScope).trim();
        const grantedScope = String(existingInfo && existingInfo.grantedScope || '').trim();
        return res.json({
          status:'already-connected', remote, type:'google-drive', existing:true,
          broker:existingInfo ? existingInfo.broker !== false : true,
          scope:configuredScope || requestedScope,
          requestedScope:configuredScope || requestedScope,
          configuredScope:configuredScope || requestedScope,
          grantedScope:grantedScope || null,
        });
      }

      // Preferred path: a central Direct-Xfer OAuth broker owns the single Google
      // Web client and refresh tokens. The broker is a preference, not a single
      // point of failure: if it is unreachable we transparently fall back to an
      // already configured local Web client, or (for a browser on the same host)
      // to rclone's native loopback OAuth flow.
      const brokerClient = currentBrokerClient();
      const brokerConfigured = !!(brokerClient && typeof brokerClient.configured === 'function' && brokerClient.configured());
      let brokerStartError = '';
      if (brokerConfigured) {
        try {
          const brokerSession = await brokerClient.createSession({ scope:requestedScope });
          const id = crypto.randomBytes(18).toString('hex');
          const item = {
            id, ownerId:owner(req), remote, replace, scope:requestedScope,
            actorUsername:String(req.session && req.session.username || 'admin'), actorIp:String(clientIp(req) || ''), browserSessionHash:browserSessionHash(req),
            broker:true, brokerSession, brokerClient, status:'waiting', error:null, createdAt:Date.now(), updatedAt:Date.now(),
          };
          googleWebSessions.set(id, item);
          auditReq(req, 'google-oauth-broker-started', `${remote} (${googleDriveRcloneScope(requestedScope)})`);
          return res.status(201).json({ id, status:'waiting', authUrl:brokerSession.authUrl, broker:true, scope:requestedScope, requestedScope, grantedScope:null });
        } catch (error) {
          brokerStartError = String(error && error.code || 'oauth-broker-unreachable').slice(0,120);
          auditReq(req, 'google-oauth-broker-fallback', `${remote} (${brokerStartError})`);
        }
      }

      // Backward-compatible local Web OAuth fallback. If a local Web profile is
      // already present, broker downtime is invisible to the user.
      const profile = googleOAuthProfileStore && typeof googleOAuthProfileStore.get === 'function' ? googleOAuthProfileStore.get() : null;
      if (!profile || !profile.clientId || !profile.clientSecret || profile.kind !== 'web') {
        const localBrowserLikely = requestCanUseLoopbackOAuth(req) || !!(req.body && req.body.localBrowser === true);
        if (localBrowserLikely) {
          // A same-machine rclone loopback flow is a valid execution path, not an
          // error. Returning it as 409 made the browser render an error state and
          // left the Retry button recycling the same impossible broker attempt.
          return res.status(202).json({
            status:'fallback',
            fallback:'rclone-local',
            remote,
            replace,
            scope:requestedScope,
            brokerUnavailable:!!brokerStartError,
            localBrowserLikely:true,
          });
        }
        const errorCode = brokerStartError || (brokerConfigured ? 'oauth-broker-failed' : 'oauth-broker-not-configured');
        const statusCode = errorCode === 'oauth-broker-rate-limited' || errorCode === 'rate-limited' ? 429
          : (errorCode === 'oauth-broker-unreachable' || errorCode === 'oauth-broker-timeout' ? 503 : 428);
        return res.status(statusCode).json({
          error:errorCode,
          brokerConfigured, brokerUnavailable:!!brokerStartError, brokerError:brokerStartError || null,
          brokerUrl:currentBrokerUrl(), brokerManaged:brokerManaged(),
          fallback:'none',
          localBrowserLikely:false,
          callbackUrl:googleCallbackUrl(req),
          retryable:['oauth-broker-unreachable','oauth-broker-timeout','oauth-broker-rate-limited','rate-limited','oauth-broker-failed'].includes(errorCode),
          setupRequired:!brokerConfigured || errorCode === 'broker-google-not-configured',
        });
      }
      const callbackUrl = googleCallbackUrl(req);
      if (!callbackUrl) return res.status(400).json({ error:'google-web-oauth-callback-invalid' });
      const localCallback = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(callbackUrl);
      if (!callbackUrl.startsWith('https://') && !localCallback) return res.status(400).json({ error:'google-web-oauth-https-required', callbackUrl });
      const id = crypto.randomBytes(18).toString('hex'), state = crypto.randomBytes(32).toString('hex');
      const verifier = base64url(crypto.randomBytes(48));
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      const item = {
        id, state, ownerId:owner(req), remote, replace, scope:requestedScope,
        actorUsername:String(req.session && req.session.username || 'admin'), actorIp:String(clientIp(req) || ''), browserSessionHash:browserSessionHash(req),
        clientId:profile.clientId, clientSecret:profile.clientSecret, verifier, callbackUrl,
        status:'waiting', error:null, createdAt:Date.now(), updatedAt:Date.now(),
      };
      if (ASVS_L3_MODE && !item.browserSessionHash) return res.status(401).json({ error:'oauth-user-agent-session-required' });
      googleWebSessions.set(id, item);
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.searchParams.set('client_id', item.clientId); auth.searchParams.set('redirect_uri', callbackUrl); auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', requestedScope); auth.searchParams.set('access_type', 'offline'); auth.searchParams.set('prompt', 'consent');
      auth.searchParams.set('state', state); auth.searchParams.set('code_challenge', challenge); auth.searchParams.set('code_challenge_method', 'S256');
      auditReq(req, 'google-web-oauth-started', `${remote} (${googleDriveRcloneScope(requestedScope)})`);
      return res.status(201).json({ id, status:'waiting', authUrl:auth.toString(), callbackUrl, broker:false, scope:requestedScope, requestedScope, grantedScope:null });
    } catch (error) {
      const code = String(error && error.code || 'google-web-oauth-start-failed');
      const status = code === 'rclone-unavailable' || code === 'oauth-broker-unreachable' || code === 'oauth-broker-timeout' ? 503 : code === 'oauth-broker-rate-limited' || code === 'rate-limited' ? 429 : 502;
      return res.status(status).json({ error:code });
    }
  });

  adminRouter.get('/storage/oauth/google-session/:id', requireFullAdmin, async (req, res) => {
    cleanup();
    const item = googleWebSessions.get(String(req.params.id || ''));
    if (!item || item.ownerId !== owner(req)) return res.status(404).json({ error:'google-web-oauth-session-not-found' });
    if (item.broker && ['waiting','exchanging'].includes(item.status)) {
      try {
        if (item.finalizePromise) {
          await item.finalizePromise;
        } else {
          const brokerClient = item.brokerClient || googleOAuthBrokerClient;
          const brokerState = await brokerClient.poll(item.brokerSession);
          item.updatedAt = Date.now();
          if (brokerState.status === 'error') {
            item.status='error';
            item.error=brokerState.error || 'oauth-broker-failed';
          } else if (brokerState.status === 'completed' && brokerState.credential) {
            // Multiple browser polls may overlap after the broker completes. Only
            // one request may mutate rclone.conf; otherwise a second poll could
            // see the freshly-created remote as "remote-exists" and overwrite the
            // successful session with an error.
            item.status = 'exchanging';
            item.finalizePromise = (async () => {
              // Preserve the exact scope returned by the broker before validation.
              // This is safe to expose to the authenticated admin and makes any
              // least-privilege mismatch visible instead of hiding it behind a
              // generic OAuth error.
              item.grantedScope = String(brokerState.credential && brokerState.credential.token && brokerState.credential.token.scope || '').trim();
              const credential = brokerClient.validateCredential(brokerState.credential, { scope:item.scope });
              await storageConnectorService.createGoogleBrokerRemote(item.remote, credential, { replace:item.replace, scope:item.scope });
              // Confirm broker-session consumption before declaring completion.
              // If it fails, leave the remote usable but surface a retryable broker
              // cleanup warning rather than silently risking stale session state.
              try { await brokerClient.consume(item.brokerSession); }
              catch (_) {}
              item.status='completed';
              item.error=null;
              item.updatedAt=Date.now();
              invalidateConnectorProbe();
              logAudit('storage-remote-configured', { username:item.actorUsername || 'admin', account:getAccountById(item.ownerId), ip:item.actorIp || '', detail:`${item.remote} (google-drive oauth-broker)` });
            })();
            try { await item.finalizePromise; }
            finally { item.finalizePromise = null; }
          } else if (brokerState.status === 'exchanging') {
            item.status = 'exchanging';
          }
        }
      } catch (error) {
        item.status='error';
        item.error=String(error && error.code || 'oauth-broker-failed').slice(0,120);
        item.diagnostic=typeof safeRcloneErrorDetail === 'function' ? safeRcloneErrorDetail(error) : null;
        item.updatedAt=Date.now();
        item.finalizePromise = null;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id:item.id, status:item.status, remote:item.remote, error:item.error || null, diagnostic:item.diagnostic || null, broker:!!item.broker, scope:item.scope || GOOGLE_DRIVE_SCOPES.limited, requestedScope:item.scope || GOOGLE_DRIVE_SCOPES.limited, grantedScope:item.grantedScope || null });
  });

  // Local callback is retained only for the advanced per-instance fallback. The
  // central broker has its own fixed callback and never sends Google codes here.
  adminRouter.get('/storage/oauth/google/callback', async (req, res) => {
    cleanGoogleWebSessions();
    const state = String(req.query && req.query.state || '');
    const item = [...googleWebSessions.values()].find((x) => x && !x.broker && x.state === state);
    const escapeHtml = (value) => String(value || '').replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    const html = (title, message, ok) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body data-dx-google-oauth-ok="${ok?'1':'0'}" style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:620px;padding:32px;text-align:center"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p style="opacity:.72">Vous pouvez fermer cette fenêtre si elle ne se ferme pas automatiquement.</p></main><script src="/google-oauth-complete.js"></script></body></html>`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!item) return res.status(400).send(html('Connexion expirée', 'Revenez à Direct-Xfer et relancez la connexion Google Drive.', false));
    const callbackBrowserHash = browserSessionHash(req);
    if (item.browserSessionHash && !safeHashEqual(item.browserSessionHash, callbackBrowserHash)) {
      auditReq(req, 'google-web-oauth-browser-mismatch', item.remote || '');
      return res.status(400).send(html('Navigateur non reconnu', 'Cette autorisation OAuth doit revenir dans le même navigateur qui a démarré la connexion.', false));
    }
    if (ASVS_L3_MODE && !item.browserSessionHash) return res.status(400).send(html('Connexion expirée', 'Relancez la connexion OAuth.', false));
    if (item.status !== 'waiting') return res.status(409).send(html('Connexion déjà traitée', 'Revenez à Direct-Xfer.', item.status === 'completed'));
    item.updatedAt = Date.now();
    const providerError = String(req.query && req.query.error || '');
    if (providerError) { item.status='error'; item.error=providerError === 'access_denied' ? 'oauth-access-denied' : 'google-web-oauth-provider-error'; return res.status(400).send(html('Connexion annulée','Google n’a pas autorisé l’accès.',false)); }
    const code = String(req.query && req.query.code || '');
    if (!code || code.length > 8192) { item.status='error'; item.error='google-web-oauth-code-missing'; return res.status(400).send(html('Connexion incomplète','Google n’a pas renvoyé de code valide.',false)); }
    item.status='exchanging';
    try {
      const body = new URLSearchParams({ code, client_id:item.clientId, client_secret:item.clientSecret, redirect_uri:item.callbackUrl, grant_type:'authorization_code', code_verifier:item.verifier });
      const googleTokenUrl = 'https://oauth2.googleapis.com/token';
      assertAsvsL3OutboundUrl(googleTokenUrl, { asvsL3Mode:ASVS_L3_MODE, allowlist:ASVS_L3_EGRESS_ALLOWLIST });
      const tokenResponse = await fetch(googleTokenUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'}, body, redirect:ASVS_L3_MODE ? 'error' : 'follow', signal:AbortSignal.timeout(15000) });
      let tokenData=null; try { tokenData=await tokenResponse.json(); } catch (_) {}
      if (!tokenResponse.ok || !tokenData || !tokenData.access_token) {
        const providerCode=String(tokenData && tokenData.error || ''); item.status='error';
        item.error=providerCode==='invalid_grant'?'google-web-oauth-invalid-grant':providerCode==='invalid_client'?'oauth-invalid-client':providerCode==='redirect_uri_mismatch'?'google-web-oauth-redirect-mismatch':'oauth-token-exchange-failed';
        return res.status(400).send(html('Connexion Google Drive échouée','Direct-Xfer n’a pas pu finaliser l’autorisation.',false));
      }
      const token={ access_token:String(tokenData.access_token),token_type:String(tokenData.token_type||'Bearer'),refresh_token:String(tokenData.refresh_token||''),scope:String(tokenData.scope||item.scope||''),expiry:new Date(Date.now()+Math.max(60,Number(tokenData.expires_in)||3600)*1000).toISOString() };
      if (!token.refresh_token) throw Object.assign(new Error('refresh token missing'),{code:'google-web-oauth-refresh-token-missing'});
      item.grantedScope=String(token.scope||'').trim();
      const grantedScopes=new Set(String(token.scope||'').split(/\s+/).filter(Boolean));
      if(!grantedScopes.has(item.scope))throw Object.assign(new Error('google-web-oauth-scope-mismatch'),{code:'google-web-oauth-scope-mismatch'});
      if(item.scope!==GOOGLE_DRIVE_SCOPES.full&&grantedScopes.has(GOOGLE_DRIVE_SCOPES.full))throw Object.assign(new Error('google-web-oauth-scope-mismatch'),{code:'google-web-oauth-scope-mismatch'});
      await storageConnectorService.createGoogleOAuthTokenRemote(item.remote,{clientId:item.clientId,clientSecret:item.clientSecret,token},{replace:item.replace,scope:item.scope});
      item.status='completed'; item.error=null; item.updatedAt=Date.now(); invalidateConnectorProbe();
      logAudit('storage-remote-configured',{username:item.actorUsername||'admin',account:getAccountById(item.ownerId),ip:item.actorIp||'',detail:`${item.remote} (google-drive web-oauth fallback)`});
      return res.send(html('Google Drive connecté','La connexion est terminée.',true));
    } catch (error) { item.status='error'; item.error=String(error&&error.code||'oauth-token-exchange-failed').slice(0,120); item.diagnostic=typeof safeRcloneErrorDetail === 'function' ? safeRcloneErrorDetail(error) : null; item.updatedAt=Date.now(); return res.status(500).send(html('Connexion Google Drive échouée','Direct-Xfer n’a pas pu terminer la connexion.',false)); }
  });


  adminRouter.post('/storage/remotes/google-direct', requireFullAdmin, async (req, res) => {
    const remote = String(req.body && req.body.remote || '').trim().replace(/:$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) return res.status(400).json({ error:'invalid-rclone-config' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const credentials = body.credentials;
    const folderValue = String(body.folder || body.rootFolderId || '').trim();
    let rootFolderId = folderValue, resourceKey = '';
    try {
      if (/^https?:\/\//i.test(folderValue)) {
        const url = new URL(folderValue);
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'drive.google.com' || url.username || url.password) {
          return res.status(400).json({ error:'google-drive-folder-invalid' });
        }
        const match = url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,256})/);
        rootFolderId = match ? match[1] : String(url.searchParams.get('id') || '');
        resourceKey = String(url.searchParams.get('resourcekey') || url.searchParams.get('resourceKey') || '').trim();
      } else {
        resourceKey = String(body.resourceKey || '').trim();
      }
    } catch (_) { return res.status(400).json({ error:'google-drive-folder-invalid' }); }
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(rootFolderId)) return res.status(400).json({ error:'google-drive-folder-required' });
    if (resourceKey && !/^[A-Za-z0-9_-]{1,256}$/.test(resourceKey)) return res.status(400).json({ error:'google-drive-folder-invalid' });
    try {
      const caps = await storageConnectorService.capabilities();
      if (!caps || !caps.available) return res.status(503).json({ error:'rclone-unavailable' });
      if (!storageConnectorService || typeof storageConnectorService.createGoogleServiceAccountRemote !== 'function') {
        return res.status(501).json({ error:'google-direct-unavailable' });
      }
      // Validate every destructive-input prerequisite before replacing an existing
      // remote so a bad JSON key or impersonation address can never erase a working
      // configuration.
      if (typeof storageConnectorService.validateGoogleServiceAccount === 'function') storageConnectorService.validateGoogleServiceAccount(credentials);
      const impersonate = String(body.impersonate || '').trim();
      if (impersonate && (!/^[^@\s]+@[^@\s]+$/.test(impersonate) || impersonate.length > 320)) return res.status(400).json({ error:'google-drive-impersonate-invalid' });
      const result = await storageConnectorService.createGoogleServiceAccountRemote(remote, credentials, {
        rootFolderId,
        resourceKey,
        readOnly:body.readOnly === true,
        impersonate,
        replace:body.replace === true,
      });
      invalidateConnectorProbe();
      auditReq(req, 'storage-remote-configured-direct', `${remote} (google-drive service-account)`);
      return res.status(201).json({ ok:true, remote:result.remote, type:'google-drive', method:'service-account', clientEmail:result.clientEmail, rootFolderId:result.rootFolderId, resourceKey:result.resourceKey || '', readOnly:result.readOnly, impersonate:result.impersonate || '', verified:result.verified === true });
    } catch (error) {
      const code = String(error && error.code || 'connector-failed');
      const status = code === 'remote-exists' ? 409
        : code === 'connector-rollback-failed' ? 500
        : code === 'rclone-unavailable' || code === 'connector-unreachable' || code === 'connector-rate-limited' ? 503
        : ['EINVAL','google-service-account-invalid','google-drive-folder-required','google-drive-folder-invalid','google-drive-impersonate-invalid','google-service-account-storage-unsafe'].includes(code) ? 400
        : ['connector-auth-failed','connector-forbidden','connector-not-found'].includes(code) ? 422 : 502;
      return res.status(status).json({ error:code });
    }
  });

  adminRouter.post('/storage/remotes/config/start', requireFullAdmin, async (req, res) => {
    cleanup();
    const remote = String(req.body && req.body.remote || '').trim().replace(/:$/, '');
    const type = String(req.body && req.body.type || '').trim().toLowerCase();
    const backend = connectorBackendType(type);
    if (!backend || !CONNECTOR_TYPES.has(type) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) {
      return res.status(400).json({ error:'invalid-rclone-config' });
    }
    // L3 must not allow a deployment to silently downgrade a connector to a
    // transport whose encryption is optional or server-dependent. SMB/WebDAV
    // remain available in compatibility mode; L3 permits SFTP and the cloud
    // providers whose rclone backends use encrypted transports.
    if (ASVS_L3_MODE && (type === 'smb' || type === 'webdav')) {
      return res.status(400).json({ error:'asvs-l3-encrypted-connector-required' });
    }
    try {
      const caps = await storageConnectorService.capabilities();
      if (!caps || !caps.available) return res.status(503).json({ error:'rclone-unavailable' });
      const oauthConfig = req.body && req.body.oauthConfig && typeof req.body.oauthConfig === 'object' ? req.body.oauthConfig : {};
      const parameters = {};
      if (type === 'google-drive') {
        const requestedScope = normalizeGoogleDriveScope(oauthConfig.scope);
        if (!requestedScope) return res.status(400).json({ error:'invalid-google-drive-scope' });
        parameters.scope = googleDriveRcloneScope(requestedScope);
        let clientId = String(oauthConfig.clientId || '').trim();
        let clientSecret = String(oauthConfig.clientSecret || '').trim();
        if ((!clientId || !clientSecret) && googleOAuthProfileStore && typeof googleOAuthProfileStore.get === 'function') {
          const saved = googleOAuthProfileStore.get();
          if (saved) {
            clientId = String(saved.clientId || '').trim();
            clientSecret = String(saved.clientSecret || '').trim();
          }
        }
        // This generic rclone-config route remains for advanced/legacy OAuth flows.
        // The normal Google Drive path uses /storage/remotes/google-oauth/start and
        // a Web-application callback handled directly by Direct-Xfer. Reject a
        // half-configured custom pair here to avoid a misleading OAuth failure.
        if (clientId || clientSecret) {
          if (!clientId) return res.status(400).json({ error:'oauth-google-client-id-required' });
          if (!clientSecret) return res.status(400).json({ error:'oauth-google-client-secret-required' });
          parameters.client_id = clientId;
          parameters.client_secret = clientSecret;
        }
      }
      const replaceExisting = req.body && req.body.replace === true;
      if (replaceExisting) {
        try { await storageConnectorService.deleteRemote(remote); } catch (error) {
          if (!error || error.code !== 'remote-not-found') throw error;
        }
      }
      const question = await storageConnectorService.configCreateStart(remote, type, { parameters });
      const session = {
        id:crypto.randomBytes(18).toString('hex'), ownerId:owner(req), remote, type, backend, parameters,
        status:'question', question, all:!OAUTH_CONNECTOR_TYPES.has(type), authUrl:'', error:null,
        oauthCallbackRequired:false, oauthHandle:null, oauthTokenQuestion:null, oauthAttempt:0, createdAt:Date.now(), updatedAt:Date.now(),
      };
      finish(session, question); sessions.set(session.id, session);
      auditReq(req, 'storage-remote-config-started', `${remote} (${type})`);
      res.status(201).json(publicSession(req, session));
    } catch (error) {
      const code = String(error && error.code || 'connector-failed');
      const status = code === 'remote-exists' ? 409 : code === 'rclone-unavailable' ? 503 : (code === 'EINVAL' || code.startsWith('oauth-google-client-') || code === 'oauth-google-profile-required') ? 400 : 502;
      res.status(status).json({ error:code });
    }
  });

  adminRouter.post('/storage/remotes/config/:id/answer', requireFullAdmin, async (req, res) => {
    cleanup(); const session = findSession(req, req.params.id);
    if (!session) return res.status(404).json({ error:'config-session-not-found' });
    if (session.status === 'oauth-starting' || session.status === 'oauth-waiting') return res.status(409).json({ error:'oauth-in-progress' });
    if (session.status === 'completed') return res.json(publicSession(req, session));
    const question = session.question;
    if (!question || !question.state) return res.status(409).json({ error:'config-session-invalid' });
    let answer = req.body && req.body.result; if (answer == null) answer = ''; answer = String(answer);
    if (answer.length > 1024 * 1024) return res.status(413).json({ error:'config-answer-too-large' });
    try {
      session.status = 'working'; session.updatedAt = Date.now();
      const continueFn = typeof storageConnectorService.configContinueToQuestion === 'function'
        ? storageConnectorService.configContinueToQuestion.bind(storageConnectorService)
        : storageConnectorService.configContinue.bind(storageConnectorService);
      const next = await continueFn(session.remote, question.state, answer, { all:session.all, connectorType:session.type, parameters:session.parameters });
      finish(session, next);
      if (session.status === 'completed') auditReq(req, 'storage-remote-configured', `${session.remote} (${session.type})`);
      res.json(publicSession(req, session));
    } catch (error) {
      session.status = 'question'; session.updatedAt = Date.now();
      res.status(502).json({ error:String(error && error.code || 'connector-failed') });
    }
  });

  adminRouter.post('/storage/remotes/config/:id/retry', requireFullAdmin, async (req, res) => {
    cleanup(); const session = findSession(req, req.params.id);
    if (!session) return res.status(404).json({ error:'config-session-not-found' });
    if (session.status === 'completed') return res.status(409).json({ error:'config-already-completed' });
    try {
      await restartSession(session);
      auditReq(req, 'storage-remote-config-retried', `${session.remote} (${session.type})`);
      res.json(publicSession(req, session));
    } catch (error) {
      session.status = 'error';
      session.error = String(error && error.code || 'connector-failed').slice(0, 120);
      session.updatedAt = Date.now();
      res.status(502).json({ error:session.error });
    }
  });

  adminRouter.post('/storage/remotes/config/:id/oauth', requireFullAdmin, async (req, res) => {
    cleanup(); const session = findSession(req, req.params.id);
    if (!session) return res.status(404).json({ error:'config-session-not-found' });
    if (!OAUTH_CONNECTOR_TYPES.has(session.type)) return res.status(400).json({ error:'oauth-not-supported' });
    const optionName = String(session.question && session.question.option && session.question.option.Name || '');
    if (optionName !== 'config_is_local') return res.status(409).json({ error:'oauth-not-ready' });
    if (activeOAuthSessionId && activeOAuthSessionId !== session.id) return res.status(409).json({ error:'oauth-busy' });
    if (session.oauthHandle) return res.json(publicSession(req, session));

    activeOAuthSessionId = session.id;
    session.status = 'oauth-starting';
    session.updatedAt = Date.now();
    session.error = null;
    session.authUrl = '';
    session.oauthCallbackRequired = false;
    session.oauthTokenQuestion = null;
    const oauthAttempt = (Number(session.oauthAttempt) || 0) + 1;
    session.oauthAttempt = oauthAttempt;
    const actor = { username:String(req.session && req.session.username || 'admin'), accountId:owner(req), ip:clientIp(req) };

    try {
      // Preferred path: continue the exact non-interactive rclone config session
      // with config_is_local=true. This lets rclone itself start the loopback OAuth
      // listener while preserving every option already collected for the remote.
      // It is substantially more robust than parsing a generated `rclone authorize`
      // command out of config_token help text.
      if (typeof storageConnectorService.startOAuthConfigAuthorization === 'function') {
        const handle = storageConnectorService.startOAuthConfigAuthorization(session.remote, session.question.state, {
          all:session.all,
          connectorType:session.type, parameters:session.parameters,
          timeoutMs:10 * 60 * 1000,
          onUrl:(url) => {
            if (!sessions.has(session.id) || session.oauthAttempt !== oauthAttempt) return;
            session.authUrl = url;
            session.oauthCallbackRequired = true;
            session.status = 'oauth-waiting';
            session.updatedAt = Date.now();
          },
        });
        session.oauthHandle = handle;
        handle.promise.then(({ question }) => {
          try {
            if (!sessions.has(session.id) || session.oauthAttempt !== oauthAttempt) return;
            finish(session, question);
            session.authUrl = '';
            session.oauthCallbackRequired = false;
            session.oauthHandle = null;
            session.oauthTokenQuestion = null;
            if (session.status === 'completed') {
              logAudit('storage-remote-configured', { username:actor.username, account:getAccountById(actor.accountId), ip:actor.ip, detail:`${session.remote} (${session.type})` });
            }
          } catch (error) {
            if (sessions.has(session.id) && session.oauthAttempt === oauthAttempt) {
              session.status = 'error';
              session.error = String(error && error.code || 'oauth-failed').slice(0, 120);
              session.updatedAt = Date.now();
              session.oauthHandle = null;
            }
          } finally {
            if (activeOAuthSessionId === session.id && session.oauthAttempt === oauthAttempt) activeOAuthSessionId = '';
          }
        }, (error) => {
          if (sessions.has(session.id) && session.oauthAttempt === oauthAttempt) {
            session.status = 'error';
            session.error = String(error && error.code || 'oauth-failed').slice(0,120);
            session.updatedAt = Date.now();
            session.oauthHandle = null;
            session.oauthTokenQuestion = null;
            if (activeOAuthSessionId === session.id) activeOAuthSessionId = '';
          }
        });
        return res.status(202).json(publicSession(req, session));
      }

      // Compatibility fallback for older/custom storage adapters.
      const prepared = typeof storageConnectorService.prepareOAuthAuthorization === 'function'
        ? await storageConnectorService.prepareOAuthAuthorization(session.remote, session.type, session.question.state, { all:session.all, connectorType:session.type, parameters:session.parameters })
        : null;
      if (!sessions.has(session.id) || session.oauthAttempt !== oauthAttempt) {
        if (activeOAuthSessionId === session.id) activeOAuthSessionId = '';
        return res.status(409).json({ error:'oauth-attempt-stale' });
      }
      if (!prepared || !prepared.question || !Array.isArray(prepared.authorizeArgs)) {
        throw Object.assign(new Error('OAuth preparation failed'), { code:'oauth-token-step-missing' });
      }
      session.oauthTokenQuestion = prepared.question;

      const handle = storageConnectorService.startOAuthAuthorization(session.type, {
        authorizeArgs:prepared.authorizeArgs,
        timeoutMs:10 * 60 * 1000,
        onUrl:(url) => {
          if (!sessions.has(session.id) || session.oauthAttempt !== oauthAttempt) return;
          session.authUrl = url;
          session.oauthCallbackRequired = true;
          session.status = 'oauth-waiting';
          session.updatedAt = Date.now();
        },
      });
      session.oauthHandle = handle;
      handle.promise.then(async ({ token }) => {
        try {
          if (!sessions.has(session.id) || session.oauthAttempt !== oauthAttempt) return;
          const tokenQuestion = session.oauthTokenQuestion;
          if (!tokenQuestion || !tokenQuestion.state || String(tokenQuestion.option && tokenQuestion.option.Name || '') !== 'config_token') {
            throw Object.assign(new Error('oauth-token-step-missing'), { code:'oauth-token-step-missing' });
          }
          const continueFn = typeof storageConnectorService.configContinueToQuestion === 'function'
            ? storageConnectorService.configContinueToQuestion.bind(storageConnectorService)
            : storageConnectorService.configContinue.bind(storageConnectorService);
          const next = await continueFn(session.remote, tokenQuestion.state, token, { all:session.all, connectorType:session.type, parameters:session.parameters });
          if (!sessions.has(session.id) || session.oauthAttempt !== oauthAttempt) return;
          finish(session, next);
          session.authUrl = '';
          session.oauthCallbackRequired = false;
          session.oauthHandle = null;
          session.oauthTokenQuestion = null;
          if (session.status === 'completed') {
            logAudit('storage-remote-configured', { username:actor.username, account:getAccountById(actor.accountId), ip:actor.ip, detail:`${session.remote} (${session.type})` });
          }
        } catch (error) {
          if (sessions.has(session.id) && session.oauthAttempt === oauthAttempt) {
            session.status = 'error';
            session.error = String(error && error.code || 'oauth-failed').slice(0, 120);
            session.updatedAt = Date.now();
            session.oauthHandle = null;
            session.oauthTokenQuestion = null;
          }
        } finally {
          if (activeOAuthSessionId === session.id && session.oauthAttempt === oauthAttempt) activeOAuthSessionId = '';
        }
      }, (error) => {
        if (sessions.has(session.id) && session.oauthAttempt === oauthAttempt) {
          session.status = 'error';
          session.error = String(error && error.code || 'oauth-failed').slice(0,120);
          session.updatedAt = Date.now();
          session.oauthHandle = null;
          session.oauthTokenQuestion = null;
          if (activeOAuthSessionId === session.id) activeOAuthSessionId = '';
        }
      });
      res.status(202).json(publicSession(req, session));
    } catch (error) {
      if (activeOAuthSessionId === session.id) activeOAuthSessionId = '';
      session.status = 'error';
      session.oauthHandle = null;
      session.oauthTokenQuestion = null;
      session.authUrl = '';
      session.oauthCallbackRequired = false;
      session.error = String(error && error.code || 'oauth-failed').slice(0, 120);
      session.updatedAt = Date.now();
      res.status(502).json({ error:session.error });
    }
  });

  adminRouter.post('/storage/remotes/config/:id/oauth/callback', requireFullAdmin, async (req, res) => {
    cleanup(); const session = findSession(req, req.params.id);
    if (!session) return res.status(404).json({ error:'config-session-not-found' });
    if (!session.oauthHandle || typeof session.oauthHandle.acceptCallback !== 'function' || !session.oauthCallbackRequired) {
      return res.status(409).json({ error:'oauth-callback-not-ready' });
    }
    const callbackUrl = String(req.body && req.body.url || '').trim();
    if (!callbackUrl || callbackUrl.length > 32768) return res.status(400).json({ error:'oauth-callback-invalid' });
    try {
      await session.oauthHandle.acceptCallback(callbackUrl);
      session.updatedAt = Date.now();
      res.status(202).json(publicSession(req, session));
    } catch (error) {
      const code = String(error && error.code || 'oauth-callback-invalid');
      const status = code === 'oauth-callback-not-ready' ? 409 : 400;
      res.status(status).json({ error:code });
    }
  });

  adminRouter.get('/storage/remotes/config/:id', requireFullAdmin, (req, res) => {
    cleanup(); const session = findSession(req, req.params.id);
    if (!session) return res.status(404).json({ error:'config-session-not-found' });
    res.json(publicSession(req, session));
  });

  adminRouter.delete('/storage/remotes/config/:id', requireFullAdmin, async (req, res) => {
    const session = findSession(req, req.params.id);
    if (!session) return res.status(404).json({ error:'config-session-not-found' });
    sessions.delete(session.id);
    clearOAuth(session);
    if (session.status !== 'completed') { try { await storageConnectorService.deleteRemote(session.remote); } catch (_) {} }
    invalidateConnectorProbe(); res.json({ ok:true });
  });

  return { cleanup };
}

module.exports = { createStorageConnectorConfigRoutes };
