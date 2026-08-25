'use strict';

const { createAsvsL3TransportGuard } = require('./asvs-l3-policy');

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
const SAFE_HTTP_METHOD_SET = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSP_REPORT_PATH = '/__csp-report';
const CSP_REPORT_WINDOW_MS = 5 * 60 * 1000;
const CSP_REPORTS_PER_WINDOW = 60;
const LEGACY_PWA_BEARER_COOKIE = 'dxpwa';
const HOST_PWA_BEARER_COOKIE = '__Host-dxpwa';
const LEGACY_PWA_MARKER_COOKIE = 'dxpwaid';
const HOST_PWA_MARKER_COOKIE = '__Host-dxpwaid';
const PWA_COOKIE_MAX_AGE = 365 * 86400;

function createHttpApplication(deps = {}) {
  const {
    ADMIN_ALLOW_ANY,
    ADMIN_ALLOWED_IPS,
    ASVS_L3_MODE = false,
    TRUST_PROXY,
    clientIp,
    crypto,
    express,
    getSettings,
    ipInList,
    isLocalNetwork,
    isLoopback,
    localCaModeActive,
    logAudit = null,
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

  function requestPathname(req) {
    const value = String((req && (req.originalUrl || req.url || req.path)) || '');
    return value.split('?', 1)[0] || '/';
  }

  function isSameOriginProtectedPath(req) {
    const pathname = requestPathname(req);
    return /^\/(?:api|app)(?:\/|$)/i.test(pathname)
      || ADMIN_SPA_ROUTES.includes(pathname);
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

  function parsedCookiePairs(raw) {
    const result = [];
    for (const part of String(raw || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 1) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name) continue;
      result.push([name, value]);
    }
    return result;
  }

  function securePwaCredential(value) {
    const raw = String(value || '');
    return /^[a-f0-9]{24}\.[A-Za-z0-9_-]{32,128}$/i.test(raw) ? raw : '';
  }

  function securePwaMarker(value) {
    const raw = String(value || '');
    return /^[a-f0-9]{24}$/i.test(raw) ? raw : '';
  }

  function rewriteInboundSecurePwaCookies(req) {
    if (!req.secure) return { bearer:'', marker:'' };
    const pairs = parsedCookiePairs(req.headers.cookie);
    const map = new Map(pairs);
    const hostBearer = securePwaCredential(map.get(HOST_PWA_BEARER_COOKIE));
    const legacyBearer = securePwaCredential(map.get(LEGACY_PWA_BEARER_COOKIE));
    const hostMarker = securePwaMarker(map.get(HOST_PWA_MARKER_COOKIE));
    const legacyMarker = securePwaMarker(map.get(LEGACY_PWA_MARKER_COOKIE));

    if (hostBearer || hostMarker) {
      const filtered = pairs.filter(([name]) => name !== LEGACY_PWA_BEARER_COOKIE && name !== LEGACY_PWA_MARKER_COOKIE);
      if (hostBearer) filtered.push([LEGACY_PWA_BEARER_COOKIE, hostBearer]);
      else if (legacyBearer) filtered.push([LEGACY_PWA_BEARER_COOKIE, legacyBearer]);
      if (hostMarker) filtered.push([LEGACY_PWA_MARKER_COOKIE, hostMarker]);
      else if (legacyMarker) filtered.push([LEGACY_PWA_MARKER_COOKIE, legacyMarker]);
      req.headers.cookie = filtered.map(([name, value]) => `${name}=${value}`).join('; ');
    }
    return {
      bearer:hostBearer ? '' : legacyBearer,
      marker:hostMarker ? '' : legacyMarker,
    };
  }

  function upgradeSecurePwaSetCookie(value) {
    const values = Array.isArray(value) ? value : [value];
    const out = [];
    for (const entry of values) {
      let cookie = String(entry || '');
      if (cookie.startsWith(LEGACY_PWA_BEARER_COOKIE + '=')) {
        cookie = HOST_PWA_BEARER_COOKIE + cookie.slice(LEGACY_PWA_BEARER_COOKIE.length);
        cookie = cookie.replace(/;\s*Path=\/app(?=;|$)/i, '; Path=/');
        if (!/;\s*Secure(?:;|$)/i.test(cookie)) cookie += '; Secure';
      } else if (cookie.startsWith(LEGACY_PWA_MARKER_COOKIE + '=')) {
        cookie = HOST_PWA_MARKER_COOKIE + cookie.slice(LEGACY_PWA_MARKER_COOKIE.length);
        if (!/;\s*Secure(?:;|$)/i.test(cookie)) cookie += '; Secure';
      }
      out.push(cookie);
    }
    return Array.isArray(value) ? out : out[0];
  }

  function installSecurePwaCookieCompatibility(req, res) {
    if (!req.secure) return;
    const legacy = rewriteInboundSecurePwaCookies(req);
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (String(name || '').toLowerCase() === 'set-cookie') {
        return originalSetHeader(name, upgradeSecurePwaSetCookie(value));
      }
      return originalSetHeader(name, value);
    };

    // One-response migration for existing secure installations. Values are
    // strictly syntax-validated before reflection into Set-Cookie. The old cookie
    // remains temporarily harmless: once the __Host value exists, request parsing
    // above always gives it precedence over any unprefixed shadow cookie.
    const migration = [];
    if (legacy.bearer) {
      migration.push(`${HOST_PWA_BEARER_COOKIE}=${legacy.bearer}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PWA_COOKIE_MAX_AGE}; Secure`);
    }
    if (legacy.marker) {
      migration.push(`${HOST_PWA_MARKER_COOKIE}=${legacy.marker}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PWA_COOKIE_MAX_AGE}; Secure`);
    }
    if (migration.length) originalSetHeader('Set-Cookie', migration);
  }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

  // L3 refuses plaintext application traffic. A loopback-only health probe remains
  // available for container/runtime liveness without exposing credentials or data.
  if (ASVS_L3_MODE === true) app.use(createAsvsL3TransportGuard({ enabled:true, isLoopback }));

  // One request-local nonce is shared by the header and HTML rendering helpers.
  app.use((req, res, next) => {
    installSecurePwaCookieCompatibility(req, res);
    const cspNonce = crypto.randomBytes(18).toString('base64');
    requestContext.run({ cspNonce }, () => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      if (isSameOriginProtectedPath(req)) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      // Local-CA HTTPS is toggleable. Clear a previously remembered HSTS policy
      // when that mode is active so switching the LAN instance back to HTTP does
      // not leave an old one-year browser policy locking out the owner. Public/
      // reverse-proxy HTTPS receives the ASVS-required subdomain coverage.
      if (req.secure) {
        res.setHeader(
          'Strict-Transport-Security',
          localCaModeActive() ? 'max-age=0' : `max-age=31536000; includeSubDomains${ASVS_L3_MODE ? '; preload' : ''}`
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

  // ASVS V4.1.1: guarantee a declared media type whenever application code
  // writes a non-empty body. Express already sets precise types for json/html/file
  // helpers; this last-resort boundary prevents a newly-added raw write/end path
  // from emitting an untyped response.
  app.use((req, res, next) => {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const ensureType = (chunk) => {
      if (chunk == null || res.headersSent || res.getHeader('Content-Type')) return;
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (length > 0) res.setHeader('Content-Type', 'application/octet-stream');
    };
    res.write = (chunk, ...args) => { ensureType(chunk); return originalWrite(chunk, ...args); };
    res.end = (chunk, ...args) => { ensureType(chunk); return originalEnd(chunk, ...args); };
    next();
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

  // L3 canonical query boundary. Reject malformed percent escapes and duplicate
  // parameter names before Express/query consumers can interpret them differently.
  // Direct-Xfer does not define security-sensitive multi-value query semantics;
  // repeated keys are therefore treated as HTTP parameter pollution.
  if (ASVS_L3_MODE === true) app.use((req, res, next) => {
    const original = String((req && (req.originalUrl || req.url)) || '');
    const qIndex = original.indexOf('?');
    if (qIndex < 0) return next();
    const raw = original.slice(qIndex + 1).split('#', 1)[0];
    if (!raw) return next();
    if (/%(?![0-9a-fA-F]{2})/.test(raw)) {
      noStore(res);
      return res.status(400).json({ error:'invalid-query-encoding' });
    }
    let pairs;
    try { pairs = new URLSearchParams(raw); } catch (_) {
      noStore(res);
      return res.status(400).json({ error:'invalid-query' });
    }
    const seen = new Set();
    for (const [name, value] of pairs) {
      if (!name || name.includes('\0') || value.includes('\0')) {
        noStore(res);
        return res.status(400).json({ error:'invalid-query' });
      }
      if (seen.has(name)) {
        noStore(res);
        return res.status(400).json({ error:'duplicate-query-parameter' });
      }
      seen.add(name);
    }
    return next();
  });

  // API responses may contain authenticated state, object metadata, paths or
  // security decisions. Keep them out of browser/shared caches by default rather
  // than relying on every route to remember the header. Public file/share pages
  // keep their explicit cache policies outside /api.
  app.use((req, res, next) => {
    if (isApiRequest(req)) noStore(res);
    return next();
  });

  // ASVS V16.3.3/V16.3.4: in the strict profile, centralize logging of
  // rejected security/control decisions and unexpected server failures. Route
  // modules still emit richer domain events; this boundary guarantees that a
  // newly-added API/app route cannot silently omit the baseline event. Queries and
  // bodies are intentionally excluded so credentials/C2/C3 data are not logged.
  if (ASVS_L3_MODE === true && typeof logAudit === 'function') app.use((req, res, next) => {
    res.once('finish', () => {
      const status = Number(res.statusCode) || 0;
      const pathname = requestPathname(req).slice(0, 240);
      const method = String(req.method || '').toUpperCase().slice(0, 12);
      try {
        if ([400, 401, 403, 405, 409, 413, 415, 422, 426, 429].includes(status)) {
          logAudit('security-control-rejected', {
            username:req.session && req.session.username ? String(req.session.username).slice(0, 120) : 'anonymous',
            ip:clientIp(req),
            detail:`${method} ${pathname} · status=${status}`,
          });
        } else if (status >= 500) {
          logAudit('security-control-failure', {
            username:req.session && req.session.username ? String(req.session.username).slice(0, 120) : 'system',
            ip:clientIp(req),
            detail:`${method} ${pathname} · status=${status}`,
          });
        }
      } catch (_) {}
    });
    next();
  });

  // Fetch Metadata adds a browser-enforced request provenance signal on top of
  // Direct-Xfer's CSRF tokens. Cross-site state changes are rejected globally.
  // Public shares may intentionally be embedded/downloaded cross-site, so safe
  // GET/HEAD loads remain available there; authenticated /api and /app resources
  // additionally reject cross-site subresource fetches while preserving explicit
  // top-level navigation to login/install pages.
  app.use((req, res, next) => {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site !== 'cross-site') return next();
    const method = String(req.method || '').toUpperCase();
    const mode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
    const pathname = requestPathname(req);
    const apiRequest = /^\/api(?:\/|$)/i.test(pathname);
    if (!SAFE_HTTP_METHOD_SET.has(method)
        || apiRequest
        || (isSameOriginProtectedPath(req) && mode !== 'navigate')) {
      noStore(res);
      return res.status(403).json({ error:'cross-site-request-blocked' });
    }
    return next();
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