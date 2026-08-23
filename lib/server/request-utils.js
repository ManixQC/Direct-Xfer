'use strict';

// Small HTTP request helpers shared across the composition root and most domain
// services: client-IP resolution (trust-proxy aware), cookie parsing and the
// Secure-cookie flag. Grouped in one factory so the composition root injects a
// single consistent policy (TRUST_PROXY) and the helpers stay unit-testable in
// isolation. secureCookie and parseCookies are pure; clientIp closes over the
// configured trust-proxy policy captured at construction time.
function createRequestUtils(deps = {}) {
  const { TRUST_PROXY } = deps;

  // Marks cookies "Secure" ONLY when the browser connection is actually HTTPS.
  // req.protocol honors X-Forwarded-Proto behind the trusted proxy. This avoids a
  // blanket Secure flag that a browser silently drops over plain HTTP (which broke
  // auth — the session cookie was never stored/sent — behind an HTTP-facing setup).
  function secureCookie(req) {
    return req && req.protocol === 'https' ? '; Secure' : '';
  }

  function clientIp(req) {
    // Express resolves req.ip according to the configured trust-proxy policy.
    // Reading the left-most X-Forwarded-For value directly lets a client spoof
    // its address when a numeric proxy-hop policy is used.
    if (TRUST_PROXY && req && req.ip) return req.ip;
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = Object.create(null);
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > -1) {
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) {
          // A malformed percent escape is an invalid cookie, not a server error.
          try { out[k] = decodeURIComponent(v); } catch (_) {}
        }
      }
    }
    return out;
  }

  return { clientIp, parseCookies, secureCookie };
}

module.exports = { createRequestUtils };
