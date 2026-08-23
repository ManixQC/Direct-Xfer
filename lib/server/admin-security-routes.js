'use strict';

const SECURITY_HISTORY_ACTIONS = new Set([
  'login', 'login-fail', 'login-2fa-fail', 'logout', 'password-changed', 'password-reset', '2fa-enabled', '2fa-disabled',
  'account-created', 'account-deleted', 'account-renamed', 'ransomware-blocked', 'ransomware-unblocked', 'dlp-blocked', 'dlp-warning',
  'dlp-overridden', 'dlp-detected', 'passkey-added', 'passkey-removed', 'passkey-login', 'passkey-login-fail', 'passkeys-disabled',
  'pwa-device-paired', 'pwa-device-revoked', 'session-revoked', 'settings-changed', 'diagnostic-fix-requested', 'diagnostic-fix', 'diagnostic-fix-failed',
]);

function attachAdminSecurityRoutes(deps = {}) {
  const {
    adminRouter,
    requireAuditAccess,
    requireFullAdmin,
    ransomwareBlocks,
    ransomwareShareBlocks,
    scheduleFlush,
    getSettings,
    anomalyRecent,
    anomalyWindows,
    persistNow,
    auditReq,
    crypto,
    sessionService,
    publicIp,
    invalidateSessionSid,
    secureCookie,
    getState,
    verifyAuditChain,
    ensureAuditProofKeys,
    auditProofKeyId,
    parseAuditChainFile,
    buildAuditProof,
    verifyAuditProofBundle,
    timingSafeEqualStr,
    csvField,
    appName,
    fs,
    path,
    dlpQuarantineRecords,
    dlpQuarantineFilePath,
    schedulePersistRetry,
  } = deps;

  if (!adminRouter) throw new TypeError('admin-security-routes requires adminRouter');
  if (!sessionService) throw new TypeError('admin-security-routes requires sessionService');
  if (!crypto || typeof crypto.createHash !== 'function') throw new TypeError('admin-security-routes requires crypto');
  for (const [name, value] of Object.entries({
    requireAuditAccess,
    requireFullAdmin,
    ransomwareBlocks,
    ransomwareShareBlocks,
    scheduleFlush,
    getSettings,
    persistNow,
    auditReq,
    publicIp,
    invalidateSessionSid,
    secureCookie,
    getState,
    verifyAuditChain,
    ensureAuditProofKeys,
    auditProofKeyId,
    parseAuditChainFile,
    buildAuditProof,
    verifyAuditProofBundle,
    timingSafeEqualStr,
    csvField,
    dlpQuarantineRecords,
    dlpQuarantineFilePath,
    schedulePersistRetry,
  })) {
    if (typeof value !== 'function') throw new TypeError(`admin-security-routes requires ${name}()`);
  }

  function sessionPublicHandle(sid) {
    return crypto.createHash('sha256').update(`dx-session:${String(sid || '')}`).digest('hex').slice(0, 24);
  }

  function sessionBrowserLabel(userAgent) {
    const ua = String(userAgent || '');
    const browser = /FxiOS\/(\d+)/i.test(ua) ? 'Firefox'
      : /Firefox\/(\d+)/i.test(ua) ? 'Firefox'
        : /EdgiOS\/(\d+)/i.test(ua) || /EdgA?\/(\d+)/i.test(ua) ? 'Edge'
          : /CriOS\/(\d+)/i.test(ua) || /Chrome\/(\d+)/i.test(ua) ? 'Chrome'
            : /OPiOS\/(\d+)/i.test(ua) || /OPR\/(\d+)/i.test(ua) ? 'Opera'
              : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
    const os = /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS/iPadOS'
        : /Windows/i.test(ua) ? 'Windows'
          : /Mac OS X/i.test(ua) ? 'macOS'
            : /Linux/i.test(ua) ? 'Linux' : '';
    return [browser, os].filter(Boolean).join(' · ');
  }

  adminRouter.get('/security/anomalies', requireAuditAccess, (req, res) => {
    const now = Date.now();
    const blocks = ransomwareBlocks();
    const linkBlocks = ransomwareShareBlocks();
    let changed = false;
    for (const [ip, record] of Object.entries(blocks)) {
      if (!record || record.until <= now) {
        delete blocks[ip];
        changed = true;
      }
    }
    for (const [id, record] of Object.entries(linkBlocks)) {
      if (!record || record.until <= now) {
        delete linkBlocks[id];
        changed = true;
      }
    }
    if (changed) scheduleFlush();
    res.json({
      enabled: getSettings().ransomwareProtection !== false,
      blocks: Object.values(blocks),
      links: Object.values(linkBlocks),
      recent: anomalyRecent.slice(0, 50),
    });
  });

  adminRouter.post('/security/anomalies/unblock', requireFullAdmin, (req, res) => {
    const ip = String((req.body && req.body.ip) || '').trim().replace(/^::ffff:/i, '');
    const shareId = String((req.body && req.body.shareId) || '').trim();
    if (!ip && !shareId) return res.status(400).json({ error: 'missing-target' });
    const blocks = ransomwareBlocks();
    const shareBlocks = ransomwareShareBlocks();
    const existed = !!blocks[ip];
    const linkExisted = !!shareBlocks[shareId];
    const previousBlock = existed ? JSON.parse(JSON.stringify(blocks[ip])) : null;
    const previousLinkBlock = linkExisted ? JSON.parse(JSON.stringify(shareBlocks[shareId])) : null;
    const hadWindow = anomalyWindows.has(ip);
    const previousWindow = hadWindow ? anomalyWindows.get(ip) : null;
    if (ip) {
      delete blocks[ip];
      anomalyWindows.delete(ip);
    }
    if (shareId) delete shareBlocks[shareId];
    if (!persistNow()) {
      if (existed) blocks[ip] = previousBlock;
      if (linkExisted) shareBlocks[shareId] = previousLinkBlock;
      if (hadWindow) anomalyWindows.set(ip, previousWindow);
      return res.status(503).json({ error: 'write-error' });
    }
    if (existed || linkExisted) {
      auditReq(req, 'ransomware-unblocked', [ip, shareId].filter(Boolean).join(' / '));
    }
    return res.json({ ok: true, unblocked: existed || linkExisted });
  });

  // DLP quarantine is security administration, not image lifecycle. Keep the
  // durable record + staged-file deletion transaction behind the security boundary.
  adminRouter.get('/dlp/quarantine', requireAuditAccess, (req, res) => {
    const records = dlpQuarantineRecords().slice().reverse().map((r) => ({ ...r, file: r.file ? true : false }));
    res.setHeader('Cache-Control','no-store');
    res.json({ records });
  });
  adminRouter.delete('/dlp/quarantine/:id', requireFullAdmin, (req, res) => {
    const list = dlpQuarantineRecords(); const idx = list.findIndex((r) => r.id === String(req.params.id || ''));
    if (idx < 0) return res.status(404).json({ error:'not-found' });
    const rec = list[idx];
    let staged = null, original = null;
    if (rec.file) {
      original = dlpQuarantineFilePath(rec.file);
      if (!original) { rec.file = null; rec.fileMissing = true; }
      else staged = original + '.delete-' + crypto.randomBytes(5).toString('hex');
      try { if (staged) fs.renameSync(original, staged); }
      catch (e) { if (e.code === 'ENOENT') { staged = null; original = null; } else return res.status(500).json({ error:'delete-failed' }); }
    }
    list.splice(idx,1);
    if (!persistNow()) {
      list.splice(Math.min(idx,list.length),0,rec);
      if (staged && original) {
        try { fs.renameSync(staged, original); }
        catch (e) {
          rec.file = path.basename(staged);
          schedulePersistRetry();
          console.error('[dlp] quarantine delete rollback failed:', e && e.message);
        }
      }
      return res.status(503).json({ error:'write-error' });
    }
    if (staged) { try { fs.unlinkSync(staged); } catch (e) { console.error('[dlp] quarantined file cleanup failed:', e && e.message); } }
    auditReq(req,'dlp-quarantine-deleted', String(rec.name || rec.id));
    res.json({ ok:true });
  });

  adminRouter.get('/security/overview', requireAuditAccess, (req, res) => {
    const currentSid = req.session && req.session.sid;
    const activeSessions = [];
    const now = Date.now();
    for (const session of sessionService.listSessions(now)) {
      activeSessions.push({
        id: sessionPublicHandle(session.sid),
        current: session.sid === currentSid,
        username: session.username || null,
        role: session.role || null,
        ip: publicIp(session.ip || ''),
        device: sessionBrowserLabel(session.ua),
        userAgent: String(session.ua || '').slice(0, 220),
        authenticatedAt: Number(session.authenticatedAt) || 0,
        lastSeenAt: Number(session.lastSeenAt) || Number(session.authenticatedAt) || 0,
        expires: Number(session.expires) || 0,
      });
    }
    activeSessions.sort((left, right) => (right.lastSeenAt || 0) - (left.lastSeenAt || 0));
    const state = getState();
    const history = (state.audit || [])
      .filter((entry) => entry && SECURITY_HISTORY_ACTIONS.has(String(entry.action || '')))
      .slice(0, 200);
    res.json({
      sessions: activeSessions,
      history,
      canRevoke: ['owner', 'admin'].includes(req.session.role),
    });
  });

  adminRouter.delete('/security/sessions/:id', requireFullAdmin, (req, res) => {
    const wanted = String(req.params.id || '');
    let found = null;
    for (const session of sessionService.listSessions()) {
      if (sessionPublicHandle(session.sid) === wanted) {
        found = session;
        break;
      }
    }
    if (!found) return res.status(404).json({ error: 'not-found' });
    const current = found.sid === req.session.sid;
    const audited = auditReq(req, 'session-revoked', {
      code: 'session-revoked',
      params: { username: found.username || '', device: sessionBrowserLabel(found.ua), current },
      fallback: 'session revoked',
    });
    if (!audited) return res.status(503).json({ error: 'audit-write-failed' });
    invalidateSessionSid(found.sid);
    if (current) {
      res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(req)}`);
    }
    return res.json({ ok: true, current });
  });

  adminRouter.get('/audit', requireAuditAccess, (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const state = getState();
    res.json({ entries: (state.audit || []).slice(0, limit), integrity: verifyAuditChain() });
  });
  adminRouter.get('/audit/verify', requireAuditAccess, (req, res) => {
    const keys = ensureAuditProofKeys();
    res.json({
      integrity: verifyAuditChain(),
      proof: { algorithm: 'Ed25519', publicKeyId: auditProofKeyId(keys.publicKey) },
    });
  });
  adminRouter.get('/audit/signed-verify', requireAuditAccess, (req, res) => {
    const integrity = verifyAuditChain();
    if (!integrity.ok) {
      return res.status(409).json({
        ok: false,
        integrity,
        signature: { ok: false, algorithm: 'Ed25519', reason: 'audit-integrity-failed' },
      });
    }
    let entries;
    try {
      entries = parseAuditChainFile().entries;
    } catch (_) {
      return res.status(500).json({
        ok: false,
        integrity,
        signature: { ok: false, algorithm: 'Ed25519', reason: 'audit-read-failed' },
      });
    }
    try {
      const proof = buildAuditProof(entries, integrity);
      const checked = verifyAuditProofBundle(proof);
      const expectedKeyId = auditProofKeyId(ensureAuditProofKeys().publicKey);
      const trustedKey = !!(
        checked.ok
        && checked.keyId
        && timingSafeEqualStr(String(checked.keyId), String(expectedKeyId))
      );
      return res.status(trustedKey ? 200 : 409).json({
        ok: trustedKey,
        integrity,
        signature: {
          ok: trustedKey,
          algorithm: 'Ed25519',
          publicKeyId: expectedKeyId,
          reason: trustedKey ? null : (checked.reason || 'signature-invalid'),
          entries: Math.max(0, Number(checked.entries) || 0),
          head: proof.head,
          entriesSha256: proof.entriesSha256,
          exportedAt: proof.exportedAt,
        },
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        integrity,
        signature: {
          ok: false,
          algorithm: 'Ed25519',
          reason: String((error && error.code) || 'audit-signature-failed'),
        },
      });
    }
  });
  adminRouter.get('/audit/public-key', requireAuditAccess, (req, res) => {
    const keys = ensureAuditProofKeys();
    res.json({
      algorithm: 'Ed25519',
      publicKeyId: auditProofKeyId(keys.publicKey),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
  });

  adminRouter.get('/audit/export', requireAuditAccess, (req, res) => {
    const requested = String(req.query.format || 'json').toLowerCase();
    const format = ['csv', 'proof'].includes(requested) ? requested : 'json';
    if (format === 'proof') {
      const before = verifyAuditChain();
      if (!before.ok) {
        return res.status(409).json({ error: 'audit-integrity-failed', reason: before.reason });
      }
    }
    const exportAuditEntry = auditReq(req, 'audit-exported', `full journal as ${format}`);
    if (!exportAuditEntry) return res.status(503).json({ error: 'audit-write-failed' });

    let entries = [];
    const integrity = verifyAuditChain();
    try {
      entries = parseAuditChainFile().entries;
    } catch (_) {
      entries = (getState().audit || []).slice().reverse();
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'csv') {
      const rows = [['seq', 'at', 'iso', 'action', 'actor', 'role', 'ip', 'detail', 'prevHash', 'hash'].join(',')];
      for (const entry of entries) {
        rows.push([
          entry.seq,
          entry.at,
          new Date(entry.at).toISOString(),
          entry.action,
          entry.actor,
          entry.role,
          entry.ip,
          entry.detail,
          entry.prevHash,
          entry.hash,
        ].map(csvField).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-audit-${stamp}.csv"`);
      return res.send(`\ufeff${rows.join('\r\n')}`);
    }

    if (format === 'proof') {
      if (!integrity.ok) {
        return res.status(409).json({ error: 'audit-integrity-failed', reason: integrity.reason });
      }
      const proof = buildAuditProof(entries, integrity);
      const checked = verifyAuditProofBundle(proof);
      if (!checked.ok) return res.status(500).json({ error: 'audit-proof-failed', reason: checked.reason });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-audit-proof-${stamp}.json"`);
      return res.send(JSON.stringify(proof, null, 2));
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-audit-${stamp}.json"`);
    return res.send(JSON.stringify({ app: appName, exportedAt: Date.now(), integrity, entries }, null, 2));
  });
}

module.exports = { attachAdminSecurityRoutes };
