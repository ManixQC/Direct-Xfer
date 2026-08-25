'use strict';

/**
 * Creates the protected administrator router and owns the cross-cutting
 * authorization policy applied to every /api/admin route.
 *
 * Domain route modules attach to the returned router. Keeping the role gate here
 * prevents each feature module from subtly re-implementing owner/admin/operator/
 * auditor rules.
 */
function createAdminRouter(deps = {}) {
  const { express, requireAuth, getAccountById, accountNeedsPwChange, getById } = deps;
  const asvsL3Mode = deps.asvsL3Mode === true;
  const hasRecentStrongAuthentication = typeof deps.hasRecentStrongAuthentication === 'function'
    ? deps.hasRecentStrongAuthentication
    : () => false;
  const strongAuthFreshMs = Math.max(60 * 1000, Number(deps.strongAuthFreshMs) || 5 * 60 * 1000);
  if (!express || typeof express.Router !== 'function') throw new TypeError('admin-router requires express.Router()');
  for (const [name, value] of Object.entries({ requireAuth, getAccountById, accountNeedsPwChange, getById })) {
    if (typeof value !== 'function') throw new TypeError(`admin-router requires ${name}()`);
  }
  // Optional: authorization denials are audited when an auditReq sink is provided.
  const auditReq = typeof deps.auditReq === 'function' ? deps.auditReq : () => {};

  // ASVS V16.3.2: record every denied authorization decision with actor/role/IP
  // context (auditReq derives these from req.session) so failed access attempts and
  // sensitive-route denials are auditable, then return the client response.
  function deny(req, res, status, error, detail) {
    try { auditReq(req, 'authz-denied', `${req.method} ${req.path} · ${error}${detail ? ' · ' + detail : ''}`); } catch (_) {}
    return res.status(status).json({ error });
  }

  const adminRouter = express.Router();
  adminRouter.use(requireAuth);

  // Authenticated responses can contain paths, identities and configuration.
  adminRouter.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // A forced password reset is a server-side authorization boundary, not merely
  // a UI prompt. Only the minimum routes needed to complete/leave the reset flow
  // remain reachable until the credential has changed.
  adminRouter.use((req, res, next) => {
    const account = req.session && req.session.accountId
      ? getAccountById(req.session.accountId)
      : null;
    if (!accountNeedsPwChange(account)) return next();
    if (req.path === '/session' || req.path === '/password' || req.path === '/logout') return next();
    return deny(req, res, 403, 'password-change-required', 'forced credential change pending');
  });

  // Strict ASVS L3 administrator boundary. A password/TOTP session may exist only
  // long enough to bootstrap the first passkey through the dedicated /app/webauthn
  // enrollment surface. It cannot authorize the administrator API. Once a
  // phishing-resistant session is established, especially sensitive mutations
  // require that strong authentication to be recent.
  function isSensitiveOperation(req) {
    if (!req || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
    const routePath = String(req.path || '');
    return /^\/(?:password$|2fa(?:\/|$)|accounts(?:\/|$)|settings(?:\/|$)|storage-connectors(?:\/|$)|backup(?:-|\/|$)|restore(?:\/|$)|shutdown(?:\/|$)|tls(?:\/|$)|security\/sessions(?:\/|$)|ip-names(?:\/|$)|network(?:\/|$))/.test(routePath);
  }

  if (asvsL3Mode) adminRouter.use((req, res, next) => {
    if (!req.session || req.session.phishingResistant !== true || req.session.authMethod !== 'passkey') {
      return deny(req, res, 403, 'passkey-required', 'ASVS L3 administrator API requires phishing-resistant authentication');
    }
    if (isSensitiveOperation(req) && !hasRecentStrongAuthentication(req.session.sid, strongAuthFreshMs)) {
      return deny(req, res, 403, 'reauth-required', 'sensitive operation requires recent phishing-resistant authentication');
    }
    return next();
  });

  // ASVS V16.3.2 (L3) also requires every successful authorization decision,
  // including sensitive-data reads, to be logged. Attach the completion hook before
  // the role/object gates: if a later gate denies with 401/403, deny() records the
  // failure and this hook deliberately emits no misleading success record.
  if (asvsL3Mode) adminRouter.use((req, res, next) => {
    let recorded = false;
    res.once('finish', () => {
      if (recorded || res.statusCode === 401 || res.statusCode === 403) return;
      recorded = true;
      const role = req.session && req.session.role ? String(req.session.role) : 'unknown';
      try { auditReq(req, 'authz-granted', `${req.method} ${req.path} · role=${role} · status=${res.statusCode}`); } catch (_) {}
    });
    next();
  });

  function ownsShare(req, share) {
    const role = req.session && req.session.role;
    if (role === 'owner' || role === 'admin' || role === 'auditor') return true;
    return !!(share && share.ownerId && share.ownerId === req.session.accountId);
  }

  function stampOwner(share, req) {
    share.ownerId = req.session.accountId || null;
    share.ownerName = req.session.username || null;
    return share;
  }

  function requireFullAdmin(req, res, next) {
    const role = req.session && req.session.role;
    if (role === 'owner' || role === 'admin') return next();
    return deny(req, res, 403, 'forbidden', 'requires full admin');
  }

  function requireAuditAccess(req, res, next) {
    const role = req.session && req.session.role;
    if (role === 'owner' || role === 'admin' || role === 'auditor') return next();
    return deny(req, res, 403, 'forbidden', 'requires audit access');
  }

  // Authorization gate for every protected admin route. Feature modules can add
  // stricter middleware, but they cannot broaden this baseline policy.
  adminRouter.use((req, res, next) => {
    const role = req.session.role;
    if (role === 'owner' || role === 'admin') return next();
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

    if (role === 'auditor') {
      // These notification mutations alter only the current account's private
      // inbox/preferences and do not mutate global administration state.
      const ownNotificationMutation =
        (req.method === 'POST' && (
          req.path === '/notifications/read'
          || req.path === '/notifications/prefs'
          || req.path === '/notification-rules'
        ))
        || (req.method === 'DELETE' && (
          req.path === '/notifications'
          || /^\/notifications\/[^/]+$/.test(req.path)
          || /^\/notification-rules\/[^/]+$/.test(req.path)
          || /^\/security\/sessions\/[^/]+$/.test(req.path)
        ));
      return (isRead || ownNotificationMutation)
        ? next()
        : deny(req, res, 403, 'read-only', 'auditor write blocked');
    }

    if (role === 'operator') {
      if (isRead) return next();
      const routePath = req.path;
      if (/^\/(settings|accounts|ip-names|backup-now|backup-test|shutdown|history|network\/port-check)\b/.test(routePath)) {
        return deny(req, res, 403, 'forbidden', 'operator restricted route');
      }
      if (/^\/(webhook-test|email-test|digest-test)\b/.test(routePath)) {
        return deny(req, res, 403, 'forbidden', 'operator restricted route');
      }
      if (/^\/shares\/(export|import)\b/.test(routePath)) {
        return deny(req, res, 403, 'forbidden', 'operator restricted route');
      }
      const match = /^\/shares\/([^/]+)/.exec(routePath);
      if (match && !['bulk', 'export', 'import'].includes(match[1])) {
        const share = getById(match[1]);
        if (share && !ownsShare(req, share)) return deny(req, res, 403, 'forbidden', 'not share owner');
      }
      return next();
    }

    // Unknown/corrupt roles never inherit administrative privileges.
    return deny(req, res, 403, 'forbidden', 'unknown role');
  });

  return {
    adminRouter,
    ownsShare,
    stampOwner,
    requireFullAdmin,
    requireAuditAccess,
  };
}

module.exports = { createAdminRouter };
