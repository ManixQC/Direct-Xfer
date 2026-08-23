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
  if (!express || typeof express.Router !== 'function') throw new TypeError('admin-router requires express.Router()');
  for (const [name, value] of Object.entries({ requireAuth, getAccountById, accountNeedsPwChange, getById })) {
    if (typeof value !== 'function') throw new TypeError(`admin-router requires ${name}()`);
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
    return res.status(403).json({ error: 'password-change-required' });
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
    return res.status(403).json({ error: 'forbidden' });
  }

  function requireAuditAccess(req, res, next) {
    const role = req.session && req.session.role;
    if (role === 'owner' || role === 'admin' || role === 'auditor') return next();
    return res.status(403).json({ error: 'forbidden' });
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
        ));
      return (isRead || ownNotificationMutation)
        ? next()
        : res.status(403).json({ error: 'read-only' });
    }

    if (role === 'operator') {
      if (isRead) return next();
      const routePath = req.path;
      if (/^\/(settings|accounts|ip-names|backup-now|backup-test|shutdown|history|network\/port-check)\b/.test(routePath)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (/^\/(webhook-test|email-test|digest-test)\b/.test(routePath)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (/^\/shares\/(export|import)\b/.test(routePath)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const match = /^\/shares\/([^/]+)/.exec(routePath);
      if (match && !['bulk', 'export', 'import'].includes(match[1])) {
        const share = getById(match[1]);
        if (share && !ownsShare(req, share)) return res.status(403).json({ error: 'forbidden' });
      }
      return next();
    }

    // Unknown/corrupt roles never inherit administrative privileges.
    return res.status(403).json({ error: 'forbidden' });
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
