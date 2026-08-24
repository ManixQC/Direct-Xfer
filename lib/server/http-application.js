'use strict';

// Express application boundary: common security headers, administrator network
// gating, public browser assets, SPA fallbacks and final HTTP error handling.
// Domain/API routes stay in their focused route modules and are composed by
// server.js between the public and administrator surface registration phases.

const PUBLIC_ASSETS = Object.freeze([
  ['logo.svg', 'image/svg+xml', 'public, max-age=3600'],
  ['reception.js', 'text/javascript', 'no-cache'],
  ['dxcrypto.js', 'text/javascript', 'no-cache'],
  ['dxdecrypt.js', 'text/javascript', 'no-cache'],
  ['dxpow.js', 'text/javascript', 'no-cache'],
  ['dxplayer.js', 'text/javascript', 'no-cache'],
  ['media-resume.js', 'text/javascript', 'no-cache'],
  ['dxsecret.js', 'text/javascript', 'no-cache'],
  ['dxcollab.js', 'text/javascript', 'no-cache'],
]);

const ADMIN_SPA_ROUTES = Object.freeze([
  '/configuration',
  '/notifications',
  '/images',
  '/activity',
  '/dashboards',
  '/system-health',
]);

const ALLOWED_HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ALLOWED_HTTP_METHOD_SET = new Set(ALLOWED_HTTP_METHODS);
const CSP_REPORT_PATH = '/__csp-report';
const CSP_REPORT_WINDOW_MS = 5 * 60 * 1000;
const CSP_REPORTS_PER_WINDOW = 60;

function createHttpApplication(deps = {}) {
  const {
    ADMIN_ALLOW_ANY,
    ADMIN_ALLOWED_IPS,
    TRUST_PROXY,
    clientIp,
    crypto,
    express,
    getSettings,
    ipInList,
    isLocalNetwork,
    isLoopback,
    localCaModeActive,
    parseIpList,
    path,
    requestContext,
    rootDir,
    sendError,
  } = deps;

  if (!express || typeof express !== 'function' || typeof express.static !== 'function') {
    throw new TypeError('createHttpApplication requires Express');
  }
  if (!crypto || typeof crypto.randomBytes !== 'function') {
    throw new TypeError('createHttpApplication requires crypto.randomBytes');
  }
  if (!requestContext || typeof requestContext.run !== 'function') {
    throw new TypeError('createHttpApplication requires requestContext');
  }
  if (!path || typeof path.join !== 'function' || !rootDir) {
    throw new TypeError('createHttpApplication requires rootDir/path');
  }

  for (const [name, fn] of Object.entries({
    clientIp, getSettings, ipInList, isLocalNetwork, isLoopback,
    localCaModeActive, parseIpList, sendError,
  })) {
    if (typeof fn !== 'function') throw new TypeError(`createHttpApplication requires ${name}`);
  }

  let uiAllowCache = { raw:null, configured:false, list:Object.freeze([]) };
  let publicAssetsAttached = false;
  let adminSurfaceAttached = false;
  const cspReportBuckets = new Map();

  function freezeParsedIpList(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    return Object.freeze(value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      return Object.freeze({ ...entry });
    }));
  }

  function uiAdminAllowedIps() {
    let settings = null;
    try { settings = getSettings(); } catch (_) {
      // A settings read failure must never broaden administrator access. Treat it
      // as a configured-but-unusable allowlist so only loopback remains viable.
      uiAllowCache = { raw:null, configured:true, list:Object.freeze([]) };
      return uiAllowCache.list;
    }
    const raw = String((settings && settings.adminAllowedIps) || '');
    if (raw !== uiAllowCache.raw) {
      let parsed = [];
      try { parsed = parseIpList(raw); } catch (_) { parsed = []; }
      uiAllowCache = {
        raw,
        configured:raw.trim().length > 0,
        list:freezeParsedIpList(parsed),
      };
    }
    return uiAllowCache.list;
  }

  function isAdminAllowed(ip) {
    const envList = Array.isArray(ADMIN_ALLOWED_IPS) ? ADMIN_ALLOWED_IPS : [];
    if (envList.length) {
      return !!(isLoopback(ip) || ipInList(ip, envList));
    }
    const uiList = uiAdminAllowedIps();
    if (uiAllowCache.configured) {
      // Non-empty restored/corrupt UI policy that parses to zero networks must
      // fail closed instead of silently falling back to the whole LAN. Loopback
      // remains available so the owner can repair the setting locally.
      return !!(isLoopback(ip) || (uiList.length && ipInList(ip, uiList)));
    }
    if (ADMIN_ALLOW_ANY) return true;
    return !!isLocalNetwork(ip);
  }

  function isApiRequest(req) {
    // Express strips a mount prefix from req.url/req.path while executing
    // app.use('/api', ...). baseUrl/originalUrl preserve that context. Relying
    // on req.path alone therefore made mounted API denials return HTML instead
    // of the stable JSON contract expected by clients.
    const candidates = [req && req.baseUrl, req && req.originalUrl, req && req.path, req && req.url];
    return candidates.some((value) => {
      const pathname = String(value || '').split('?', 1)[0];
      return /^\/api(?:\/|$)/i.test(pathname);
    });
  }

  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }

  function adminGuard(req, res, next) {
    if (isAdminAllowed(clientIp(req))) return next();
    noStore(res);
    if (isApiRequest(req)) {
      return res.status(403).json({ error:'admin-lan-only' });
    }
    return sendError(req, res, 403, 'adminLanOnly');
  }

  function safeReportField(value, max = 300) {
    return String(value == null ? '' : value)
      .replace(/[\0\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, max);
  }

  function shouldLogCspReport(req, now = Date.now()) {
    const key = safeReportField(clientIp(req), 120) || 'unknown';
    let bucket = cspReportBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= CSP_REPORT_WINDOW_MS) {
      bucket = { startedAt:now, count:0 };
      cspReportBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (cspReportBuckets.size > 1024) {
      for (const [ip, entry] of cspReportBuckets) {
        if (!entry || now - Number(entry.startedAt || 0) >= CSP_REPORT_WINDOW_MS) cspReportBuckets.delete(ip);
      }
      if (cspReportBuckets.size > 1024) cspReportBuckets.clear();
    }
    return bucket.count <= CSP_REPORTS_PER_WINDOW;
  }

  function normalizedCspReport(body) {
    const candidate = Array.isArray(body) ? body[0] : body;
    if (!candidate || typeof candidate !== 'object') return null;
    const report = candidate['csp-report'] && typeof candidate['csp-report'] === 'object'
      ? candidate['csp-report']
      : (candidate.body && typeof candidate.body === 'object' ? candidate.body : candidate);
    return {
      blocked: safeReportField(report['blocked-uri'] || report.blockedURL || report.blockedUrl),
      directive: safeReportField(report['effective-directive'] || report.effectiveDirective || report.directive, 120),
      document: safeReportField(report['document-uri'] || report.documentURL || report.documentUrl),
      source: safeReportField(report['source-file'] || report.sourceFile),
    };
  }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

  // One request-local nonce is shared by the header and HTML rendering helpers.
  app.use((req, res, next) => {
    const cspNonce = crypto.randomBytes(18).toString('base64');
    requestContext.run({ cspNonce }, () => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      // Local-CA HTTPS is toggleable. Clear a previously remembered HSTS policy
      // when that mode is active so switching the LAN instance back to HTTP does
      // not leave an old one-year browser policy locking out the owner. Public/
      // reverse-proxy HTTPS receives the ASVS-required subdomain coverage.
      if (req.secure) {
        res.setHeader(
          'Strict-Transport-Security',
          localCaModeActive() ? 'max-age=0' : 'max-age=31536000; includeSubDomains'
        );
      }
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; ` +
          "img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
          `base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; report-uri ${CSP_REPORT_PATH}`
      );
      next();
    });
  });

  // Reject HTTP verbs that Direct-Xfer does not implement before any application
  // route, static-file handler, or body parser sees the request. TRACE/TRACK are
  // especially undesirable because intermediaries may reflect request metadata.
  app.use((req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    if (ALLOWED_HTTP_METHOD_SET.has(method)) return next();
    noStore(res);
    res.setHeader('Allow', ALLOWED_HTTP_METHODS.join(', '));
    return res.status(405).json({ error:'method-not-allowed' });
  });

  // CSP reports are intentionally unauthenticated because violations can occur on
  // public share/login pages before a session exists. The body is tightly bounded,
  // output is never reflected, and logging is source-rate-limited to avoid turning
  // the endpoint into a log-amplification primitive.
  app.post(
    CSP_REPORT_PATH,
    express.json({ type:['application/csp-report', 'application/reports+json', 'application/json'], limit:'32kb' }),
    (req, res) => {
      noStore(res);
      const report = normalizedCspReport(req.body);
      if (report && shouldLogCspReport(req)) {
        try {
          console.warn('[csp-report]', JSON.stringify(report));
        } catch (_) {}
      }
      return res.status(204).end();
    }
  );

  function attachPublicAssetRoutes() {
    if (publicAssetsAttached) return;
    publicAssetsAttached = true;
    for (const [file, type, cacheControl] of PUBLIC_ASSETS) {
      app.get('/' + file, (req, res) => {
        res.type(type);
        res.setHeader('Cache-Control', cacheControl);
        res.sendFile(path.join(rootDir, 'public', file));
      });
    }
  }

  function attachAdminSpaAndFallbacks() {
    if (adminSurfaceAttached) return;
    adminSurfaceAttached = true;
    const indexFile = path.join(rootDir, 'public', 'index.html');

    for (const route of ADMIN_SPA_ROUTES) {
      app.get(route, adminGuard, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexFile);
      });
    }

    // API routing is complete before this phase is attached. Terminate API
    // misses before express.static so a future public/api.html (or similar file)
    // can never shadow the JSON API namespace through the static fallback.
    app.use((req, res, next) => {
      if (!isApiRequest(req)) return next();
      noStore(res);
      return res.status(404).json({ error:'not-found' });
    });

    app.use(
      adminGuard,
      express.static(path.join(rootDir, 'public'), {
        index:'index.html',
        extensions:['html'],
        dotfiles:'ignore',
        setHeaders(res) {
          res.setHeader('Cache-Control', 'no-cache');
        },
      })
    );

    app.use((req, res) => {
      noStore(res);
      return sendError(req, res, 404, 'pageNotFound');
    });

    // Final Express error boundary. Body-parser failures are client errors, not
    // internal server failures; preserve stable API status codes without leaking
    // parser details. If streaming already started, terminate the response rather
    // than attempting to append a second HTTP message.
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
      if (res.headersSent) {
        if (typeof res.destroy === 'function') return res.destroy();
        return next(err);
      }
      noStore(res);
      if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error:'payload-too-large' });
      }
      if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error:'invalid-json' });
      }
      if (err && err.type === 'encoding.unsupported') {
        return res.status(415).json({ error:'unsupported-encoding' });
      }
      if (err && (err.type === 'request.aborted' || err.type === 'request.size.invalid')) {
        return res.status(400).json({ error:'bad-request' });
      }
      console.error('[server] unhandled error:', err && err.message);
      return res.status(500).json({ error:'server-error' });
    });
  }

  return {
    app,
    adminGuard,
    attachAdminSpaAndFallbacks,
    attachPublicAssetRoutes,
    isAdminAllowed,
    uiAdminAllowedIps,
  };
}

module.exports = { createHttpApplication };
