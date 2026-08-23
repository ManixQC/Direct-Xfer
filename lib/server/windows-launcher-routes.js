'use strict';

// Private loopback-only HTTP boundary used by the Windows launcher and ServerHost.
//
// The launcher token is a per-process capability passed through an HTTP header. It
// never appears in browser URLs: password reset pages use a separate short-lived,
// one-time ticket that is issued only after launcher-token authentication.
function attachWindowsLauncherRoutes(deps = {}) {
  const {
    APP_NAME,
    APP_VERSION,
    ADMIN_USERNAME,
    DX_WINDOWS_LAUNCHER_TOKEN,
    accountService,
    app,
    clearSessionsOfAccount,
    crypto,
    express,
    logAudit,
    ownerAccount,
    setAccountPassword,
    shutdown,
  } = deps;

  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('windows-launcher-routes requires app');
  }
  if (!express || typeof express.urlencoded !== 'function') {
    throw new TypeError('windows-launcher-routes requires express');
  }
  if (!crypto || typeof crypto.randomBytes !== 'function' || typeof crypto.timingSafeEqual !== 'function') {
    throw new TypeError('windows-launcher-routes requires crypto');
  }
  for (const [name, value] of Object.entries({
    ownerAccount,
    setAccountPassword,
    clearSessionsOfAccount,
    logAudit,
    shutdown,
  })) {
    if (typeof value !== 'function') throw new TypeError(`windows-launcher-routes requires ${name}`);
  }
  const requiredAccountMethods = [
    'clearInitialPassword',
    'hasFreshInitialPassword',
    'initialPassword',
    'isEnvironmentPasswordManaged',
  ];
  if (!accountService || requiredAccountMethods.some((name) => typeof accountService[name] !== 'function')) {
    throw new TypeError('windows-launcher-routes requires complete accountService');
  }

  const resetTickets = new Map();
  const resetFormParser = express.urlencoded({ extended:false, limit:'4kb' });
  const RESET_TICKET_TTL_MS = 2 * 60 * 1000;

  function isLoopbackAddress(value) {
    let addr = String(value || '').trim().toLowerCase();
    if (!addr) return false;
    if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
    addr = addr.split('%')[0];
    if (addr === '::1') return true;

    const ipv4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4);
    if (dotted) {
      const octets = dotted.slice(1).map(Number);
      return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127;
    }

    // Some stacks render IPv4-mapped loopback as hexadecimal IPv6
    // (for example ::ffff:7f00:1) instead of dotted decimal.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return Number.isInteger(high) && Number.isInteger(low)
        && high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff
        && ((high >>> 8) & 0xff) === 127;
    }
    return false;
  }

  function isLoopbackRequest(req) {
    return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
  }

  function launcherTokenMatches(req) {
    if (!DX_WINDOWS_LAUNCHER_TOKEN || !isLoopbackRequest(req)) return false;
    const supplied = String(req.get('X-Direct-Xfer-Launcher-Token') || '');
    const expectedBuf = Buffer.from(String(DX_WINDOWS_LAUNCHER_TOKEN));
    const suppliedBuf = Buffer.from(supplied);
    return expectedBuf.length === suppliedBuf.length && crypto.timingSafeEqual(expectedBuf, suppliedBuf);
  }

  function resetTicket(ticket, { claim=false } = {}) {
    const key = String(ticket || '');
    const rec = resetTickets.get(key);
    if (!rec || rec.claimed) return null;
    if (!Number.isFinite(rec.expiresAt) || Date.now() >= rec.expiresAt) {
      resetTickets.delete(key);
      return null;
    }
    if (claim) rec.claimed = true;
    return rec;
  }

  function ticketMatchesOwner(ticket, rec, owner) {
    if (!rec || !owner || !owner.id) return false;
    if (resetTickets.get(String(ticket || '')) !== rec) return false;
    if (!Number.isFinite(rec.expiresAt) || Date.now() >= rec.expiresAt) return false;
    return rec.ownerRef === owner
      && rec.ownerId === String(owner.id)
      && rec.ownerHash === String(owner.ah || '')
      && ownerAccount() === owner;
  }

  function releaseTicketClaim(ticket, rec) {
    if (!rec || resetTickets.get(String(ticket || '')) !== rec) return;
    if (!Number.isFinite(rec.expiresAt) || Date.now() >= rec.expiresAt) {
      resetTickets.delete(String(ticket || ''));
      return;
    }
    rec.claimed = false;
  }

  function invalidateTicket(ticket) {
    resetTickets.delete(String(ticket || ''));
  }

  function issueResetTicket(owner) {
    resetTickets.clear();
    const ticket = crypto.randomBytes(32).toString('base64url');
    resetTickets.set(ticket, {
      expiresAt:Date.now() + RESET_TICKET_TTL_MS,
      claimed:false,
      ownerRef:owner,
      ownerId:String(owner.id),
      ownerHash:String(owner.ah || ''),
    });
    return ticket;
  }

  function resetStrings(lang) {
    if (lang === 'fr') return {
      title:'Réinitialiser le mot de passe admin', intro:'Cette action locale remplace le mot de passe du compte propriétaire Direct-Xfer et déconnecte ses sessions Web actives.',
      account:'Compte', password:'Nouveau mot de passe', confirm:'Confirmer le mot de passe', submit:'Réinitialiser le mot de passe',
      mismatch:'Les mots de passe ne correspondent pas.', short:'Le mot de passe doit contenir au moins 8 caractères.', success:'Mot de passe administrateur réinitialisé. Vous pouvez fermer cette page et vous reconnecter.', expired:'Cette demande de réinitialisation a expiré. Relancez-la depuis l’icône Direct-Xfer.', env:'Le mot de passe propriétaire est géré par la variable ADMIN_PASSWORD et ne peut pas être remplacé depuis la systray.', failed:'Impossible d’enregistrer le nouveau mot de passe.'
    };
    if (lang === 'es') return {
      title:'Restablecer la contraseña de administrador', intro:'Esta acción local reemplaza la contraseña de la cuenta propietaria de Direct-Xfer y cierra sus sesiones web activas.',
      account:'Cuenta', password:'Nueva contraseña', confirm:'Confirmar contraseña', submit:'Restablecer contraseña',
      mismatch:'Las contraseñas no coinciden.', short:'La contraseña debe contener al menos 8 caracteres.', success:'Contraseña de administrador restablecida. Puedes cerrar esta página e iniciar sesión de nuevo.', expired:'Esta solicitud de restablecimiento ha caducado. Vuelve a iniciarla desde el icono de Direct-Xfer.', env:'La contraseña del propietario está gestionada por la variable ADMIN_PASSWORD y no puede reemplazarse desde la bandeja del sistema.', failed:'No se pudo guardar la nueva contraseña.'
    };
    return {
      title:'Reset admin password', intro:'This local action replaces the Direct-Xfer owner account password and signs out its active web sessions.',
      account:'Account', password:'New password', confirm:'Confirm password', submit:'Reset password',
      mismatch:'The passwords do not match.', short:'The password must contain at least 8 characters.', success:'Administrator password reset. You can close this page and sign in again.', expired:'This reset request has expired. Start it again from the Direct-Xfer tray icon.', env:'The owner password is managed by the ADMIN_PASSWORD environment variable and cannot be replaced from the system tray.', failed:'The new password could not be saved.'
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>\"']/g, (c) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;'
    }[c]));
  }

  function resetPage({ lang, ticket, message, showForm=true }) {
    const tx = resetStrings(lang);
    const owner = ownerAccount();
    const account = owner ? owner.username : 'admin';
    const msg = message ? `<p role="status"><strong>${escapeHtml(message)}</strong></p>` : '';
    const form = showForm ? `<form method="post" action="/__dx_launcher/reset-admin-password">
    <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
    <input type="hidden" name="lang" value="${escapeHtml(lang)}">
    <p><label>${escapeHtml(tx.password)}<br><input name="password" type="password" minlength="8" maxlength="512" autocomplete="new-password" required autofocus></label></p>
    <p><label>${escapeHtml(tx.confirm)}<br><input name="confirm" type="password" minlength="8" maxlength="512" autocomplete="new-password" required></label></p>
    <button type="submit">${escapeHtml(tx.submit)}</button>
  </form>` : '';
    return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(tx.title)}</title></head><body><main><h1>${escapeHtml(tx.title)}</h1><p>${escapeHtml(tx.intro)}</p><p>${escapeHtml(tx.account)}: <strong>${escapeHtml(account)}</strong></p>${msg}${form}</main></body></html>`;
  }

  function setPrivateNoStore(res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
  }

  function sendResetPage(res, opts, status=200) {
    res.status(status);
    setPrivateNoStore(res);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    return res.type('html').send(resetPage(opts));
  }

  app.post('/__dx_launcher/initial-admin-password', (req, res, next) => {
    if (!DX_WINDOWS_LAUNCHER_TOKEN) return next();
    if (!launcherTokenMatches(req)) return res.status(404).end();
    setPrivateNoStore(res);
    if (accountService.isEnvironmentPasswordManaged() || !accountService.hasFreshInitialPassword()) {
      return res.status(204).end();
    }
    const owner = ownerAccount();
    if (!owner) return res.status(503).json({ error:'owner-unavailable' });
    const password = accountService.initialPassword();
    const username = owner.username || ADMIN_USERNAME;
    res.json({ ok:true, fresh:true, username, password });
    accountService.clearInitialPassword();
  });

  app.post('/__dx_launcher/reset-admin-password-ticket', (req, res, next) => {
    if (!DX_WINDOWS_LAUNCHER_TOKEN) return next();
    if (!launcherTokenMatches(req)) return res.status(404).end();
    setPrivateNoStore(res);
    const owner = ownerAccount();
    if (!owner || !owner.id) return res.status(503).json({ error:'owner-unavailable' });
    if (accountService.isEnvironmentPasswordManaged()) return res.status(409).json({ error:'env-managed' });
    const ticket = issueResetTicket(owner);
    return res.json({ ok:true, ticket, expiresIn:Math.floor(RESET_TICKET_TTL_MS / 1000) });
  });

  app.get('/__dx_launcher/reset-admin-password', (req, res, next) => {
    if (!DX_WINDOWS_LAUNCHER_TOKEN) return next();
    if (!isLoopbackRequest(req)) return res.status(404).end();
    const queryLang = String(req.query && req.query.lang || '');
    const lang = ['fr','en','es'].includes(queryLang) ? queryLang : 'en';
    const ticket = String(req.query && req.query.ticket || '');
    const rec = resetTicket(ticket);
    if (!rec) return sendResetPage(res, { lang, ticket:'', message:resetStrings(lang).expired, showForm:false }, 410);
    if (accountService.isEnvironmentPasswordManaged()) {
      invalidateTicket(ticket);
      return sendResetPage(res, { lang, ticket:'', message:resetStrings(lang).env, showForm:false }, 409);
    }
    const owner = ownerAccount();
    if (!ticketMatchesOwner(ticket, rec, owner)) {
      invalidateTicket(ticket);
      return sendResetPage(res, { lang, ticket:'', message:resetStrings(lang).expired, showForm:false }, 410);
    }
    return sendResetPage(res, { lang, ticket, showForm:true });
  });

  function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  }

  function resetBrowserGate(req, res, next) {
    if (!DX_WINDOWS_LAUNCHER_TOKEN) return next('route');
    if (!isLoopbackRequest(req)) return res.status(404).end();
    return next();
  }

  app.post('/__dx_launcher/reset-admin-password', resetBrowserGate, resetFormParser, asyncRoute(async (req, res) => {
    const langValue = String(req.body && req.body.lang || '');
    const lang = ['fr','en','es'].includes(langValue) ? langValue : 'en';
    const tx = resetStrings(lang);
    const ticket = String(req.body && req.body.ticket || '');
    const rec = resetTicket(ticket);
    if (!rec) return sendResetPage(res, { lang, ticket:'', message:tx.expired, showForm:false }, 410);
    if (accountService.isEnvironmentPasswordManaged()) {
      invalidateTicket(ticket);
      return sendResetPage(res, { lang, ticket:'', message:tx.env, showForm:false }, 409);
    }
    const password = String(req.body && req.body.password || '');
    const confirm = String(req.body && req.body.confirm || '');
    if (password.length < 8 || password.length > 512) return sendResetPage(res, { lang, ticket, message:tx.short, showForm:true }, 400);
    if (password !== confirm) return sendResetPage(res, { lang, ticket, message:tx.mismatch, showForm:true }, 400);
    const owner = ownerAccount();
    if (!ticketMatchesOwner(ticket, rec, owner)) {
      invalidateTicket(ticket);
      return sendResetPage(res, { lang, ticket:'', message:tx.expired, showForm:false }, 410);
    }

    // Claim before the asynchronous password hash. This makes the recovery
    // capability single-flight and prevents two concurrent submissions from
    // both committing. The beforeCommit check also invalidates an in-flight
    // reset if the owner, password source or recovery ticket changes meanwhile.
    const claimed = resetTicket(ticket, { claim:true });
    if (claimed !== rec) return sendResetPage(res, { lang, ticket:'', message:tx.expired, showForm:false }, 410);

    let passwordUpdate;
    try {
      passwordUpdate = await setAccountPassword(owner, password, {
        pwChanged:true,
        beforeCommit:() => !accountService.isEnvironmentPasswordManaged()
          && rec.claimed === true
          && ticketMatchesOwner(ticket, rec, owner),
      });
    } catch (_) {
      releaseTicketClaim(ticket, rec);
      return sendResetPage(res, { lang, ticket, message:tx.failed, showForm:true }, 503);
    }
    if (!passwordUpdate || !passwordUpdate.ok) {
      if (passwordUpdate && (passwordUpdate.error === 'account-changed' || passwordUpdate.error === 'not-authorized')) {
        invalidateTicket(ticket);
        return sendResetPage(res, { lang, ticket:'', message:tx.expired, showForm:false }, 409);
      }
      releaseTicketClaim(ticket, rec);
      return sendResetPage(res, { lang, ticket, message:tx.failed, showForm:true }, 503);
    }

    invalidateTicket(ticket);
    accountService.clearInitialPassword();
    clearSessionsOfAccount(owner.id);
    logAudit('password-reset', { account:owner, ip:'127.0.0.1', detail:'windows-launcher-local', suppressSecurityAlert:false });
    return sendResetPage(res, { lang, ticket:'', message:tx.success, showForm:false });
  }));

  app.get('/__dx_launcher/ready', (req, res, next) => {
    if (!DX_WINDOWS_LAUNCHER_TOKEN) return next();
    if (!launcherTokenMatches(req)) return res.status(404).end();
    setPrivateNoStore(res);
    return res.json({ ok:true, app:APP_NAME, version:APP_VERSION, pid:process.pid });
  });

  app.post('/__dx_launcher/shutdown', (req, res, next) => {
    if (!DX_WINDOWS_LAUNCHER_TOKEN) return next();
    if (!launcherTokenMatches(req)) return res.status(404).end();
    setPrivateNoStore(res);
    res.status(202).json({ ok:true });
    setTimeout(() => {
      Promise.resolve().then(() => shutdown('windows-server-host')).catch(() => {});
    }, 150);
  });

  return Object.freeze({ clearResetTickets:() => resetTickets.clear() });
}

module.exports = { attachWindowsLauncherRoutes };
