'use strict';

// Public download/share HTTP boundary for Direct-Xfer.
//
// This module owns visitor-facing share/image/gallery/secret routes and the
// request-time helpers that are specific to those routes. Durable share state,
// transfer streaming, image storage and writable reception/collaboration remain
// in their dedicated services and are injected here by server.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createPublicShareRoutes(deps = {}) {
  const {
    ACCESS_REQUESTS_MAX,
    FULL_IMAGES_DIR,
    HOST_ROOT,
    IMAGE_MAX_BYTES,
    PUB,
    PUBLIC_MESSAGE_DUP_MS,
    PWA_IMG_EXT,
    SECRETS_DIR,
    SUBTITLE_MAX_BYTES,
    VISITOR_FEEDBACK_MAX,
    accessRequestPage,
    albumPage,
    addShare,
    addShareCenterNotification,
    assertRealWithin,
    authService,
    bandwidthCapReached,
    beginUnlockAttempt,
    bumpViews,
    challengeGateZip,
    checkSharePassword,
    createPowChallenge,
    clampIndex,
    cleanConnectorPath,
    clientIp,
    collectionPage,
    connectorErrorCode,
    detachActiveShare,
    destroyShareManagedData,
    emitLiveActivity,
    encDecryptPage,
    encodePath,
    errorPage,
    esc,
    express,
    filePage,
    firstExistingPhotoFile,
    flagFromCode,
    finishUnlockAttempt,
    folderPage,
    formatBytes,
    geolocate,
    geoSync,
    getByToken,
    getSettings,
    getState,
    hasAccessRules,
    highlightCode,
    hostToContainer,
    imageContentType,
    imageDimensions,
    incrementDownloads,
    issuePowCookie,
    ipDownloadQuotaBlocked,
    isAccessApproved,
    isActive,
    isScheduled,
    isUnlocked,
    linkAccessReason,
    linkPrefix,
    mapLimit,
    maskIp,
    mediaPlayerPage,
    notePhotoView,
    noteUnlockFailure,
    noteUnlockSuccess,
    notify,
    pageShell,
    passwordPage,
    pendingAccessRequest,
    persistNow,
    photoAdaptivePath,
    photoCacheRevision,
    photoExt,
    photoOriginalPaths,
    photoVariantPaths,
    pickLang,
    previewInfo,
    previewWatermark,
    primaryBase,
    pubIp,
    publicMessageDecision,
    publicRateRetryAfter,
    readFileCapped,
    readZipEntries,
    recipientByToken,
    recordAndCheckVisitor,
    recordRecipientView,
    renderKind,
    renderMarkdown,
    resolveWithin,
    restorePublicMessageDecision,
    scheduleFlush,
    scheduleSearchReindex,
    secretPage,
    sendError,
    sendPasswordWorkHtml,
    serveWebStorageFile,
    setAccessRequestCookie,
    setUnlockCookie,
    shareEffectiveExpiry,
    shareItems,
    snapshotPublicMessageDecision,
    srtToVtt,
    stampPhotoUploadDevice,
    streamFile,
    streamToFileBounded,
    streamZip,
    streamZipFiles,
    timingSafeEqualStr,
    upgradeLegacySharePassword,
    verifyPowChallenge,
    webStorageFolderPage,
    webStorageList,
    webStorageShareMeta,
    webStorageStat,
    zipAllowed,
  } = deps;

  if (!express || typeof express.Router !== 'function') throw new TypeError('public-share-routes requires express');
  if (typeof getByToken !== 'function') throw new TypeError('public-share-routes requires getByToken');
  if (typeof sendError !== 'function') throw new TypeError('public-share-routes requires sendError');
  if (typeof getState !== 'function') throw new TypeError('public-share-routes requires getState');
  for (const [name, value] of Object.entries({
    accessRequestPage, bandwidthCapReached, clientIp, errorPage, getSettings,
    hasAccessRules, ipDownloadQuotaBlocked, isAccessApproved, isActive,
    isUnlocked, linkAccessReason, pendingAccessRequest, pickLang,
    recordAndCheckVisitor, shareItems,
  })) {
    if (typeof value !== 'function') throw new TypeError(`public-share-routes requires ${name}`);
  }
  if (!recipientByToken || typeof recipientByToken.get !== 'function') throw new TypeError('public-share-routes requires recipientByToken');
  for (const [name, value] of Object.entries({
    beginUnlockAttempt, createPowChallenge, finishUnlockAttempt, noteUnlockFailure, noteUnlockSuccess,
    upgradeLegacySharePassword, verifyPowChallenge,
  })) {
    if (typeof value !== 'function') throw new TypeError(`public-share-routes requires ${name}`);
  }

  const downloadRouter = express.Router();
downloadRouter.use((req, res, next) => {
  // Token-bearing public pages and JSON responses can reveal share names and
  // metadata. Individual immutable image routes explicitly override this.
  res.setHeader('Cache-Control', 'no-store');
  const q = String((req.query && req.query.lang) || '').toLowerCase();
  if (['fr', 'en', 'es'].includes(q)) {
    res.setHeader('Set-Cookie', `lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  next();
});

// Per-IP rate limit on actual transfer requests (downloads, uploads,
// zips). Landing pages and inline previews (/view, thumbnails) are not counted so
// browsing a gallery never trips it; the proof-of-work endpoints are exempt too.
downloadRouter.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/dx/')) return next(); // never throttle solving the challenge
  const isTransfer =
    /\/(download|enc|upload|dedupe)(?:\/|$)/.test(p) ||
    /\/file\//.test(p) ||
    /(?:^|\/)(?:zip|sha256)(?:\/|$)/.test(p) ||
    /\.zip$/.test(p) ||
    /^\/c\/[^/]+\/(list|delete|folder)$/.test(p) || // collab control endpoints
    /^\/u\/[^/]+\/folder$/.test(p); // reception folder creation
  if (!isTransfer) return next();
  const retry = publicRateRetryAfter(req);
  if (!retry) return next();
  res.setHeader('Retry-After', String(retry));
  // JSON for fetch/XHR endpoints (uploads, collab list/delete); an HTML page for
  // plain browser file navigations.
  if (req.method === 'POST' || /^\/c\/[^/]+\/list$/.test(p)) {
    return res.status(429).json({ error: 'rate-limited', retryAfter: retry });
  }
  const lang = pickLang(req);
  const L = PUB[lang] || PUB.en;
  return res.status(429).type('html').send(errorPage(lang, 429, L.tooManyReq));
});

// Per-link geo/IP access rules, enforced centrally for every /s, /u
// and /c sub-path so a download/upload endpoint can't be hit directly to bypass it.
function publicPathShare(req) {
  const m = /^\/(s|u|c|i|g)\/([^/]+)/.exec(String(req.path || ''));
  if (!m) return null;
  let token = m[2];
  // /i/<token>.jpg is a cosmetic alias of /i/<token>. Tokens themselves are
  // generated from base64url and never contain a dot.
  if (m[1] === 'i') {
    const dot = token.lastIndexOf('.');
    if (dot > 0) token = token.slice(0, dot);
  }
  const share = getByToken(token);
  return share ? { share, token, kind:m[1] } : null;
}

downloadRouter.use(async (req, res, next) => {
  const match = publicPathShare(req);
  if (!match || !hasAccessRules(match.share)) return next();
  const s = match.share;
  let reason = null;
  try { reason = await linkAccessReason(req, s); }
  catch (_) { reason = s.geoMode === 'allow' ? 'geo' : null; }
  if (!reason) return next();
  const p = req.path;
  if (req.method === 'POST' || /\/(list|upload|upload-status|dedupe|delete|remove)(?:\/|$)/.test(p)) {
    return res.status(403).json({ error: 'access-denied' });
  }
  const lang = pickLang(req);
  const L = PUB[lang] || PUB.en;
  return res.status(403).type('html').send(errorPage(lang, 403, L.accessDenied || 'Access denied.'));
});

// Access-request is a share-level gate and therefore belongs at the router
// boundary, not only on /s routes. This keeps edited image/gallery/reception/
// collaboration links from bypassing approval simply by using their native path.
downloadRouter.use((req, res, next) => {
  const match = publicPathShare(req);
  if (!match) return next();
  const s = match.share;
  if (!s.requestAccess || isAccessApproved(req, s)) return next();
  const p = String(req.path || '');
  if (/\/(?:unlock|request-access)$/.test(p)) return next();
  // Preserve the existing ordering: when a link has both a password and an
  // approval gate, the visitor must unlock it before seeing the request form.
  if (s.pwHash && !isUnlocked(req, s)) return next();
  const existing = pendingAccessRequest(req, s);
  if (req.method !== 'GET' || /\/(?:list|upload|upload-status|dedupe|delete|remove|thread|message|folder)(?:\/|$)/.test(p)) {
    return res.status(401).json({ error:'access' });
  }
  return res.status(401).type('html').send(accessRequestPage(pickLang(req), s, match.token, existing));
});

// Proof-of-work endpoints (public, no token). GET issues a signed
// challenge; POST verifies the browser's solution and sets the short-lived pass
// cookie. Registered before /s and /u so they never shadow these.
const powJsonParser = express.json({ limit: '4kb' });
downloadRouter.get('/dx/pow', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(createPowChallenge(req));
});
downloadRouter.post('/dx/pow/verify', powJsonParser, (req, res) => {
  const verified = verifyPowChallenge(req, req.body);
  if (!verified.ok) return res.status(400).json({ error:verified.error });
  issuePowCookie(req, res);
  res.json({ ok: true });
});

function downloadAllowed(req, res, s) {
  if (ipDownloadQuotaBlocked(s, req)) {
    const lang = pickLang(req);
    res.status(429).type('html').send(errorPage(lang, 429, (PUB[lang] || PUB.en).quotaReached || 'Download limit reached.'));
    return false;
  }
  if (bandwidthCapReached(s)) {
    sendError(req, res, 404, 'shareGone');
    return false;
  }
  return true;
}

function requireActiveShare(req, res, opts) {
  const s = getByToken(req.params.token);
  // Scheduled (deferred activation): not yet live — say when, instead of "gone".
  if (s && isScheduled(s)) {
    const lang = pickLang(req);
    const L = PUB[lang] || PUB.en;
    const when = new Date(s.startsAt).toLocaleString(lang);
    res.status(403).type('html').send(errorPage(lang, 403, (L.notYetActive || 'Not available yet.') + ' — ' + when));
    return null;
  }
  if (!s || !isActive(s)) {
    sendError(req, res, 404, 'shareGone');
    return null;
  }
  if (s.pwHash && !isUnlocked(req, s)) {
    res.status(401).type('html').send(passwordPage(pickLang(req), s, false, req.params.token));
    return null;
  }
  // Access-request gate: an un-approved visitor sees the request
  // form instead of the content (parallel to the password gate above). Placed
  // before the visitor-cap so a pending requester doesn't consume a visitor slot.
  if (s.requestAccess && !isAccessApproved(req, s)) {
    res.status(401).type('html').send(accessRequestPage(pickLang(req), s, req.params.token, pendingAccessRequest(req, s)));
    return null;
  }
  if (!recordAndCheckVisitor(s, req)) { // N-distinct-visitor cap reached
    sendError(req, res, 404, 'shareGone');
    return null;
  }
  // Per-IP and total-bandwidth caps apply only to actual transfers. Folder-file
  // helpers defer this check until they know a ?view/?render request really is a
  // preview; otherwise a fake preview query could bypass download quotas.
  if (opts && opts.countDownload && !downloadAllowed(req, res, s)) return null;
  // Per-recipient overrides on a nominative sub-link (own expiry /
  // download cap, on top of the share's). Only applies when visited via a
  // recipient token.
  const rc = recipientByToken.get(req.params.token);
  if (rc && rc.recipient) {
    const r = rc.recipient;
    if (r.expiresAt && Date.now() >= r.expiresAt) { sendError(req, res, 404, 'shareGone'); return null; }
    if (r.maxDownloads > 0 && ((r.stats && r.stats.completed) || 0) >= r.maxDownloads) { sendError(req, res, 404, 'shareGone'); return null; }
  }
  return s;
}

// Track distinct (masked) visitor IPs and enforce a per-link cap.
// The persisted visitor set is deliberately bounded: a very large configured
// limit must never turn shares.json into an attacker-controlled unbounded IP log.
// Visitor, quota and public-view accounting now live in share-service.js.

// Safe in-browser preview: maps a file extension to a renderable kind + MIME.
// Excludes anything scriptable (html, svg, ...) — those stay download-only.
// Richer, server-rendered previews (Markdown, highlighted code, ZIP
// listing). Kept separate from previewInfo (which drives raw inline serving via
// /view); this decides which files get a rendered /render page instead.
// Returns { entries: [{name, size, dir}], truncated } or null if not a valid ZIP.
// Search, OCR and DLP implementation moved to lib/server/{search,ocr,dlp}-service.js.

// Build the full rendered-preview page (Markdown / highlighted code /
// ZIP listing) for a file. `downloadUrl` powers the download button; `viewUrl`,
// when given, offers a "raw" fallback link. Text content is capped at 2 MB.
const RENDER_MAX_BYTES = 2 * 1024 * 1024;
async function buildRenderPage(lang, title, name, abs, kind, downloadUrl, viewUrl) {
  const L = PUB[lang] || PUB.en;
  const dlBtn = `<a class="btn" href="${esc(downloadUrl)}" download rel="noopener">${esc(L.download)}</a>`;
  const rawBtn = viewUrl ? `<a class="btn btn-ghost" href="${esc(viewUrl)}" target="_blank" rel="noopener">${esc(L.rawView)}</a>` : '';
  let inner = '';
  if (kind === 'pdf') {
    inner = `<div class="pdf-preview-shell"><iframe class="pdf-preview-frame" src="${esc(viewUrl || '')}" title="${esc(name)}"></iframe></div>`;
  } else if (kind === 'archive') {
    const z = await readZipEntries(abs);
    if (!z) {
      inner = `<p class="muted">${esc(L.archiveUnreadable)}</p>`;
    } else if (!z.entries.length) {
      inner = `<p class="muted">${esc(L.archiveEmpty)}</p>`;
    } else {
      const rows = z.entries.map((e) =>
        `<tr><td class="fl-name"><span class="ico">${e.dir ? '📁' : '📄'}</span> ${esc(e.name)}</td>`
        + `<td class="fl-size">${e.dir ? '—' : esc(formatBytes(e.size))}</td></tr>`).join('');
      const note = z.truncated ? `<p class="muted sm">${esc(L.archiveTruncated)}</p>` : '';
      inner = `<p class="muted">${z.count} ${esc(L.zipEntries)}</p>`
        + `<div class="list-view"><table class="filelist"><tbody>${rows}</tbody></table></div>${note}`;
    }
  } else {
    let capped;
    try { capped = await readFileCapped(abs, RENDER_MAX_BYTES); } catch (_) { capped = { buf: Buffer.alloc(0), truncated: false }; }
    const tooBig = capped.truncated;
    const text = capped.buf.toString('utf8');
    const note = tooBig ? `<p class="muted sm">${esc(L.previewTruncated)}</p>` : '';
    if (kind === 'markdown') inner = `<div class="md-body">${renderMarkdown(text)}</div>${note}`;
    else if (kind === 'text') inner = `<pre class="code text-preview"><code>${esc(text)}</code></pre>${note}`;
    else inner = `<pre class="code hl"><code>${highlightCode(text)}</code></pre>${note}`;
  }
  const body = `
<div class="card render-card">
  <h1><span class="ico">${kind === 'archive' ? '🗜️' : kind === 'markdown' ? '📝' : kind === 'pdf' ? '📕' : '📄'}</span>${esc(name)}</h1>
  <div class="file-actions">${rawBtn}${dlBtn}</div>
  <div class="render-out">${inner}</div>
</div>`;
  return pageShell(lang, title || name, body);
}

// Download/streaming mechanics are composed through lib/server/download-service.js.

async function listDir(absDir, allowedRoot = absDir) {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  let realRoot;
  try { realRoot = await fs.promises.realpath(allowedRoot); } catch (_) { realRoot = path.resolve(allowedRoot); }
  for (const d of dirents) {
    const candidate = path.join(absDir, d.name);
    if (d.isDirectory()) {
      dirs.push({ name: d.name, isDir: true });
      continue;
    }
    if (d.isFile()) {
      files.push({ name: d.name, isDir: false, size: null });
      continue;
    }
    if (d.isSymbolicLink()) {
      // Safe symlinks inside the shared tree remain browsable, but never stat or
      // expose a target that resolves outside the share's real root.
      try {
        const real = await assertRealWithin(realRoot, candidate);
        const st = await fs.promises.stat(real);
        if (st.isDirectory()) dirs.push({ name:d.name, isDir:true, symlink:true });
        else if (st.isFile()) files.push({ name:d.name, isDir:false, size:st.size, symlink:true });
      } catch (_) {}
    }
  }
  await mapLimit(files.filter((f) => f.size == null), 32, async (f) => {
    try {
      // f.name comes from fs.readdir(); symlinks were validated above.
      f.size = (await fs.promises.stat(path.join(absDir, f.name))).size;
    } catch (_) {}
  });
  const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  dirs.sort((a, b) => coll.compare(a.name, b.name));
  files.sort((a, b) => coll.compare(a.name, b.name));
  return [...dirs, ...files];
}


downloadRouter.get('/s/:token', (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  recordRecipientView(req); // read receipt for nominative sub-links (no-op otherwise)
  bumpViews(s, req); // live views / unique-visitors counter (admin page)
  if (s.encrypted) return res.type('html').send(encDecryptPage(pickLang(req), s, req.params.token));
  const tk = req.params.token; // preserve the visited token (main link or a sub-link)
  const wm = previewWatermark(req, tk);
  if (s.type === 'web-storage') {
    const meta = webStorageShareMeta(s);
    if (!meta) return sendError(req, res, 404, 'fileUnavailable');
    if (meta.isDir) return res.redirect(302, `/s/${tk}/browse`);
    const displayShare = { ...s, previewName: String(s.webStorage && s.webStorage.sourceName || s.name || '') };
    return res.type('html').send(filePage(pickLang(req), displayShare, `/s/${tk}/download`, tk, wm));
  }
  if (s.type === 'file') {
    const items = shareItems(s) || [];
    if (!items.length) return sendError(req, res, 404, 'fileUnavailable');
    if (items.length > 1) return res.type('html').send(collectionPage(pickLang(req), s, items, tk, wm));
    if (items[0].type === 'folder') return res.redirect(302, `/s/${tk}/item/0/browse`);
    return res.type('html').send(filePage(pickLang(req), s, `/s/${tk}/download`, tk, wm));
  }
  return res.redirect(302, `/s/${tk}/browse`);
});

// Ciphertext blob of an encrypted download share (opaque; decrypted in-browser).
downloadRouter.get('/s/:token/enc', (req, res) => {
  const s = requireActiveShare(req, res, { countDownload: true });
  if (!s) return;
  if (!s.encrypted || !s.encPath) return sendError(req, res, 404, 'notFound');
  streamFile(req, res, s.encPath, path.basename(s.encPath), () => incrementDownloads(s.id), {
    shareId: s.id,
    name: s.name,
    type: 'file',
  }, { challenge: true });
});

downloadRouter.get('/s/:token/download', async (req, res) => {
  const s = requireActiveShare(req, res, { countDownload: req.method === 'GET' });
  if (!s) return;
  if (s.type === 'web-storage') {
    const meta = webStorageShareMeta(s);
    if (!meta || meta.isDir) return sendError(req, res, 404, 'notFound');
    return serveWebStorageFile(req, res, s, '', { filename:s.name || meta.sourceName || 'download', challenge:true });
  }
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const items = shareItems(s);
  const item = items[clampIndex(req.query.i, items.length)];
  try {
    const abs = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, abs);
    streamFile(req, res, abs, item.name, () => incrementDownloads(s.id), {
      shareId: s.id,
      name: item.name,
      type: 'file',
    }, { challenge: true });
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

// In-browser preview: serves the file inline with its real MIME type. Does NOT
// count as a download and is not tracked as a transfer (viewing != downloading).
downloadRouter.get('/s/:token/view', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type === 'web-storage') {
    const meta = webStorageShareMeta(s);
    if (!meta || meta.isDir) return sendError(req, res, 404, 'notFound');
    if (s.noPreview) return res.redirect(302, `/s/${req.params.token}/download`);
    const sourceName = String(s.webStorage && s.webStorage.sourceName || s.name || 'download');
    const info = previewInfo(sourceName);
    if (!info) return res.redirect(302, `/s/${req.params.token}/download`);
    if (info.kind === 'pdf') { res.setHeader('X-Frame-Options','SAMEORIGIN'); res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); }
    return serveWebStorageFile(req, res, s, '', { filename:s.name || sourceName, inline:true, contentType:info.contentType });
  }
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const items = shareItems(s) || [];
  if (!items.length) return sendError(req, res, 404, 'fileUnavailable');
  const idx = clampIndex(req.query.i, items.length);
  const item = items[idx];
  if (!item) return sendError(req, res, 404, 'fileUnavailable');
  // Preview disabled on this share ⇒ force a download instead of an inline view.
  if (s.noPreview) return res.redirect(302, `/s/${req.params.token}/download?i=${idx}`);
  const info = previewInfo(item.name);
  if (!info) return res.redirect(302, `/s/${req.params.token}/download?i=${idx}`);
  try {
    const abs = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, abs);
    if (info.kind === 'pdf') { res.setHeader('X-Frame-Options','SAMEORIGIN'); res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); }
    streamFile(req, res, abs, item.name, null, null, { inline: true, contentType: info.contentType });
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

// Photos tab — direct image links (no relay HTML page). /i/<token>[.ext] serves
// the full image; /thumb and /micro serve the two generated sizes. A missing
// variant falls back without immutable caching, so generation can replace it.
// Direct image tokens are stable, but links can be revoked. Keep a short public
// cache for hotlink performance without leaving revoked images cached for a year.
const PHOTO_PUBLIC_CACHE = 'public, max-age=3600';

// --- Anti-hotlink ---------------------------------------------
// When imageHotlinkHosts is non-empty, only requests whose Referer host matches
// the allowlist (or the server's own host, or that carry no Referer at all —
// i.e. a direct visit) are served. Subdomains of a listed host are allowed too.
function parseHotlinkHosts(input) {
  const parts = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;]+/);
  const out = [];
  for (const raw of parts) {
    if (typeof raw !== 'string') continue;
    let h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\/\//, '');
    h = h.split('/')[0].split('?')[0].replace(/:\d+$/, '').replace(/^\*\./, '');
    if (h && h.length <= 253 && /^[a-z0-9.-]+$/.test(h) && !out.includes(h)) out.push(h);
    if (out.length >= 50) break;
  }
  return out;
}
function hotlinkRefererHost(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try { return new URL(ref).hostname.toLowerCase(); } catch (_) { return null; }
}
function hotlinkAllowed(req, share) {
  // A PWA-created image may carry its own explicit policy. An empty array means
  // protection disabled for that image; absence of the property inherits the
  // instance-wide Images setting for backwards compatibility.
  const list = share && Object.prototype.hasOwnProperty.call(share, 'hotlinkHosts')
    ? share.hotlinkHosts
    : getSettings().imageHotlinkHosts;
  if (!Array.isArray(list) || !list.length) return true; // protection off
  const host = hotlinkRefererHost(req);
  if (!host) return true; // direct navigation / privacy-stripped Referer
  const self = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (self && (host === self || host.endsWith('.' + self))) return true; // same site
  return list.some((h) => host === h || host.endsWith('.' + h));
}

async function servePhoto(req, res, variant) {
  let token = String(req.params.token || '');
  const dot = token.lastIndexOf('.');
  if (dot > 0) token = token.slice(0, dot); // strip a cosmetic /i/<token>.jpg extension
  const s = getByToken(token);
  if (!s || s.type !== 'photo' || !isActive(s)) return sendError(req, res, 404, 'fileNotFound');
  res.setHeader('X-Direct-Xfer-Image-Revision', String(photoCacheRevision(s)));
  // Reject foreign embeds before password/visitor processing so a blocked site
  // cannot probe protected images or consume visitor-limit capacity.
  if (!hotlinkAllowed(req, s)) return sendError(req, res, 403, 'hotlinkBlocked');
  if (s.pwHash && !isUnlocked(req, s)) {
    return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, token));
  }
  if (!recordAndCheckVisitor(s, req)) return sendError(req, res, 404, 'fileNotFound');
  const kind = variant || 'full';
  const restrictedCache = !!s.pwHash || !!s.requestAccess || hasAccessRules(s) || Number(s.maxVisitors) > 0 || Number(s.maxViews) > 0 || !!shareEffectiveExpiry(s);
  const candidates = variant === 'micro'
    ? [
        ...photoVariantPaths(token, 'micro').map((file) => ({ ready: s.micro, file, immutable: true })),
        ...photoVariantPaths(token, 'thumb').map((file) => ({ ready: s.thumb, file, immutable: false })),
      ]
    : (variant === 'thumb'
        ? photoVariantPaths(token, 'thumb').map((file) => ({ ready: s.thumb, file, immutable: true }))
        : []);
  for (const candidate of candidates) {
    if (!candidate.ready) continue;
    try {
      if ((await fs.promises.stat(candidate.file)).isFile()) {
        return streamFile(req, res, candidate.file, token + '.jpg', () => notePhotoView(s, req, kind), null, {
          inline: true,
          contentType: 'image/jpeg',
          cacheControl: restrictedCache ? 'no-store' : (candidate.immutable ? PHOTO_PUBLIC_CACHE : 'no-store'),
        });
      }
    } catch (_) {}
  }
  try {
    let abs = firstExistingPhotoFile(photoOriginalPaths(s));
    if (!abs) {
      abs = hostToContainer(s.hostPath);
      await assertRealWithin(HOST_ROOT, abs);
    }
    const ct = imageContentType(s.imgPath || s.name) || 'application/octet-stream';
    streamFile(req, res, abs, s.name, () => notePhotoView(s, req, kind), null, {
      inline: true,
      contentType: ct,
      cacheControl: restrictedCache || variant ? 'no-store' : ((s.editedAt || s.replacedAt || s.restoredAt || s.cacheInvalidatedAt) ? 'public, max-age=0, must-revalidate' : PHOTO_PUBLIC_CACHE),
    });
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
}
async function serveAdaptivePhoto(req, res) {
  let token = String(req.params.token || '');
  const dot = token.lastIndexOf('.');
  if (dot > 0) token = token.slice(0, dot);
  const s = getByToken(token);
  if (!s || s.type !== 'photo' || !isActive(s)) return sendError(req, res, 404, 'fileNotFound');

  const width = Math.max(0, Math.min(10000, parseInt(req.query.w, 10) || parseInt(req.headers.width, 10) || parseInt(req.headers['viewport-width'], 10) || 0));
  const saveData = String(req.headers['save-data'] || '').toLowerCase() === 'on';
  const ect = String(req.headers.ect || '').toLowerCase();
  const slow = saveData || /(^|-)2g$/.test(ect) || ect === 'slow-2g';
  if (slow || (width && width <= 320)) return servePhoto(req, res, 'micro');
  if (width && width <= 900) return servePhoto(req, res, 'thumb');

  const accept = String(req.headers.accept || '');
  let format = null;
  if (/image\/avif/i.test(accept) && s.adaptiveAvif) format = 'avif';
  else if (/image\/webp/i.test(accept) && s.adaptiveWebp) format = 'webp';
  if (!format) return servePhoto(req, res, null);

  const file = photoAdaptivePath(token, format);
  try {
    if (!file || !(await fs.promises.stat(file)).isFile()) {
      if (format === 'avif') delete s.adaptiveAvif; else delete s.adaptiveWebp;
      scheduleFlush();
      return servePhoto(req, res, null);
    }
    if (!hotlinkAllowed(req, s)) return sendError(req, res, 403, 'hotlinkBlocked');
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, token));
    if (!recordAndCheckVisitor(s, req)) return sendError(req, res, 404, 'fileNotFound');
    const restrictedCache = !!s.pwHash || !!s.requestAccess || hasAccessRules(s) || Number(s.maxVisitors) > 0 || Number(s.maxViews) > 0 || !!shareEffectiveExpiry(s);
    res.setHeader('Accept-CH', 'DPR, Width, Viewport-Width, Save-Data, ECT');
    res.setHeader('Vary', 'Accept, Save-Data, Width, Viewport-Width, DPR, ECT');
    return streamFile(req, res, file, token + '.' + format, () => notePhotoView(s, req, 'full'), null, {
      inline: true,
      contentType: 'image/' + format,
      cacheControl: restrictedCache ? 'no-store' : PHOTO_PUBLIC_CACHE,
    });
  } catch (_) {
    return servePhoto(req, res, null);
  }
}
downloadRouter.get('/i/:token/auto', serveAdaptivePhoto);
downloadRouter.get('/i/:token/thumb', (req, res) => servePhoto(req, res, 'thumb'));
downloadRouter.get('/i/:token/micro', (req, res) => servePhoto(req, res, 'micro'));
downloadRouter.get('/i/:token', (req, res) => servePhoto(req, res, null));

// Public image gallery: renders an album's still-active members.
downloadRouter.get('/g/:token', (req, res) => {
  const lang = pickLang(req);
  const s = getByToken(String(req.params.token || ''));
  if (!s || s.type !== 'album' || !isActive(s)) return sendError(req, res, 404, 'shareGone');
  if (s.pwHash && !isUnlocked(req, s)) {
    return res.status(401).type('html').send(passwordPage(lang, s, false, req.params.token));
  }
  if (!recordAndCheckVisitor(s, req)) return sendError(req, res, 404, 'shareGone');
  const members = (Array.isArray(s.members) ? s.members : [])
    .map((tok) => getByToken(tok))
    .filter((m) => m && m.type === 'photo' && isActive(m));
  s.views = (s.views || 0) + 1; scheduleFlush(); // count gallery page loads
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(albumPage(lang, s, members, req));
});

function albumInviteHash(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}
function activeAlbumInvite(album, secret) {
  if (!album || album.type !== 'album' || !Array.isArray(album.collaborators)) return null;
  const hash = albumInviteHash(secret);
  const now = Date.now();
  return album.collaborators.find((entry) => entry && !entry.disabled && timingSafeEqualStr(String(entry.tokenHash || ''), hash) && (!entry.expiresAt || entry.expiresAt > now)) || null;
}
const albumUploadReservations = new WeakMap();
function reserveAlbumUpload(invite) {
  if (!invite || typeof invite !== 'object') return null;
  const pending = Math.max(0, Number(albumUploadReservations.get(invite)) || 0);
  const used = Math.max(0, Number(invite.usedFiles) || 0);
  const cap = Math.max(0, Math.floor(Number(invite.maxFiles) || 0));
  if (cap > 0 && used + pending >= cap) return null;
  albumUploadReservations.set(invite, pending + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = Math.max(0, Number(albumUploadReservations.get(invite)) || 0);
    if (current <= 1) albumUploadReservations.delete(invite); else albumUploadReservations.set(invite, current - 1);
  };
}
function albumCollaborationPage(lang, album, members, invite, secret) {
  const L = PUB[lang] || PUB.en;
  const title = album.name || L.albumTitle || 'Gallery';
  const canUpload = invite.role === 'contributor' || invite.role === 'manager';
  const canManage = invite.role === 'manager';
  const base = '/g/' + encodeURIComponent(album.token) + '/c/' + encodeURIComponent(secret);
  const cells = members.map((m) => {
    const full = '/i/' + m.token + '/auto?w=1920';
    const thumb = '/i/' + m.token + '/auto?w=480';
    const remove = canManage ? `<button class="collab-remove" type="button" data-token="${esc(m.token)}">×</button>` : '';
    const privacy = m.metadataRemoved ? `<span class="gal-privacy">🛡 ${esc(L.photoMetadataRemoved || 'EXIF/GPS removed')}</span>` : '';
    return `<div class="gal-cell-wrap"><a class="gal-cell" href="${esc(full)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(thumb)}" alt="${esc(m.name || '')}">${privacy}</a>${remove}</div>`;
  }).join('');
  const remaining = invite.maxFiles > 0 ? Math.max(0, invite.maxFiles - (invite.usedFiles || 0)) : null;
  const upload = canUpload ? `<div class="collab-upload"><h2>${lang === 'fr' ? 'Ajouter des images' : lang === 'es' ? 'Añadir imágenes' : 'Add images'}</h2><input id="collab-files" type="file" accept="image/*" multiple><button id="collab-send" class="btn" type="button">${lang === 'fr' ? 'Envoyer' : lang === 'es' ? 'Enviar' : 'Upload'}</button><p id="collab-status" class="muted"></p>${remaining === null ? '' : `<p class="muted">${remaining} ${lang === 'fr' ? 'fichier(s) restant(s)' : lang === 'es' ? 'archivo(s) restantes' : 'file(s) remaining'}</p>`}</div>` : '';
  const script = canUpload || canManage ? `<script>(function(){const base=${JSON.stringify(base)};const status=document.getElementById('collab-status');const btn=document.getElementById('collab-send');if(btn)btn.onclick=async()=>{const files=[...document.getElementById('collab-files').files];if(!files.length)return;btn.disabled=true;let ok=0;for(const file of files){status.textContent=(ok+1)+'/'+files.length+'…';const r=await fetch(base+'/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});if(r.ok)ok++;else{let e={};try{e=await r.json()}catch(_){ }status.textContent='Erreur: '+(e.error||r.status);break;}}btn.disabled=false;if(ok===files.length)location.reload();};document.querySelectorAll('.collab-remove').forEach(b=>b.onclick=async()=>{if(!confirm('Retirer cette image de l’album ?'))return;const r=await fetch(base+'/remove/'+encodeURIComponent(b.dataset.token),{method:'POST'});if(r.ok)location.reload();});})();</script>` : '';
  return pageShell(lang, title, `<style>.gal-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}.gal-head h1{margin:0;font-size:1.4rem;word-break:break-word}.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.gal-cell-wrap{position:relative}.gal-cell{position:relative;display:block;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:rgba(127,127,127,.12)}.gal-cell img{width:100%;height:100%;object-fit:cover;display:block}.gal-privacy{position:absolute;left:7px;bottom:7px;max-width:calc(100% - 14px);padding:4px 7px;border-radius:999px;background:rgba(8,24,18,.86);color:#d9ffe9;font-size:.72rem;font-weight:700;line-height:1.2}.collab-remove{position:absolute;right:5px;top:5px;border:0;border-radius:999px;background:#b91c1c;color:white;width:30px;height:30px;font-size:20px}.collab-upload{margin:0 0 18px;padding:16px;border:1px solid rgba(127,127,127,.25);border-radius:12px}.collab-upload input{display:block;margin:10px 0;max-width:100%}</style><div class="card"><div class="gal-head"><h1>${esc(title)}</h1><span class="muted">${esc(invite.label || invite.role)}</span></div>${upload}<div class="gallery-grid">${cells}</div></div>${script}`);
}

downloadRouter.get('/g/:token/c/:secret', (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  const invite = activeAlbumInvite(album, req.params.secret);
  if (!album || !invite || !isActive(album)) return sendError(req, res, 404, 'shareGone');
  const members = (Array.isArray(album.members) ? album.members : []).map(getByToken).filter((m) => m && m.type === 'photo' && isActive(m));
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(albumCollaborationPage(pickLang(req), album, members, invite, req.params.secret));
});
downloadRouter.post('/g/:token/c/:secret/upload', (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  const invite = activeAlbumInvite(album, req.params.secret);
  if (!album || !invite || !isActive(album) || !['contributor', 'manager'].includes(invite.role)) return res.status(404).json({ error: 'not-found' });
  const releaseReservation = reserveAlbumUpload(invite);
  if (!releaseReservation) return res.status(409).json({ error: 'file-limit' });
  if (typeof res.once === 'function') {
    res.once('finish', releaseReservation);
    res.once('close', releaseReservation);
  }
  const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!type.startsWith('image/')) { releaseReservation(); return res.status(415).json({ error: 'image-required' }); }
  const requestedName = String(req.query.name || '').replace(/[\/\r\n\t]+/g, ' ').trim().slice(0, 120);
  const nameExt = /\.([A-Za-z0-9]+)$/.exec(requestedName);
  let ext = (nameExt ? nameExt[1] : type.slice('image/'.length).split(/[+;]/, 1)[0]).toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (ext === 'x-ms-bmp') ext = 'bmp';
  if (!PWA_IMG_EXT.test(ext)) { releaseReservation(); return res.status(415).json({ error: 'unsupported-image' }); }
  const rawName = requestedName || ('image.' + ext);
  const max = Math.min(IMAGE_MAX_BYTES, invite.maxFileBytes > 0 ? invite.maxFileBytes : IMAGE_MAX_BYTES);
  const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
  const dest = path.join(FULL_IMAGES_DIR, fname);
  try {
    streamToFileBounded(req, res, dest, max, (size) => {
      releaseReservation();
      const beforeMembers = Array.isArray(album.members) ? album.members.slice() : [];
      const beforeUsedFiles = invite.usedFiles || 0;
      const beforeLastUsedAt = invite.lastUsedAt || 0;
      let rec = null;
      try {
        const dims = imageDimensions(dest);
        const share = { type: 'photo', name: rawName || ('image.' + ext), imgPath: fname, ext, size, contributedViaAlbum: album.token, contributedByInviteId: invite.id };
        stampPhotoUploadDevice(share, req, 'collaborator');
        if (dims) { share.w = dims.w; share.h = dims.h; }
        if (album.ownerId) share.ownerId = album.ownerId;
        if (album.ownerDeviceId) share.ownerDeviceId = album.ownerDeviceId;
        share.ownerName = album.ownerName || 'Album';
        rec = addShare(share);
        if (!Array.isArray(album.members)) album.members = [];
        album.members.push(rec.token);
        invite.usedFiles = beforeUsedFiles + 1; invite.lastUsedAt = Date.now();
        if (!persistNow()) {
          detachActiveShare(rec);
          rec = null;
          album.members = beforeMembers;
          invite.usedFiles = beforeUsedFiles;
          if (beforeLastUsedAt) invite.lastUsedAt = beforeLastUsedAt; else delete invite.lastUsedAt;
          try { fs.unlinkSync(dest); } catch (_) {}
          return res.status(503).json({ error:'write-error' });
        }
        return res.status(201).json({ ok: true, token: rec.token, url: '/i/' + rec.token + '.' + photoExt(rec) });
      } catch (e) {
        // streamToFileBounded invokes this callback asynchronously from the write
        // stream's finish event. Exceptions here are not caught by the outer
        // try/catch and would otherwise become uncaught process exceptions.
        try { if (rec) detachActiveShare(rec); } catch (_) {}
        album.members = beforeMembers;
        invite.usedFiles = beforeUsedFiles;
        if (beforeLastUsedAt) invite.lastUsedAt = beforeLastUsedAt; else delete invite.lastUsedAt;
        try { fs.unlinkSync(dest); } catch (_) {}
        console.error('[album] collaborator upload finalization failed:', e && e.message);
        if (!res.headersSent) return res.status(500).json({ error:'write-error' });
      }
    });
  } catch (e) {
    releaseReservation();
    console.error('[album] collaborator upload failed:', e && e.message);
    if (!res.headersSent) return res.status(500).json({ error:'write-error' });
  }
});
downloadRouter.post('/g/:token/c/:secret/remove/:imageToken', async (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  const invite = activeAlbumInvite(album, req.params.secret);
  if (!album || !invite || !isActive(album) || invite.role !== 'manager') return res.status(404).json({ error: 'not-found' });
  const token = String(req.params.imageToken || '');
  if (!Array.isArray(album.members) || !album.members.includes(token)) return res.status(404).json({ error: 'not-found' });
  const photo = getByToken(token);
  try {
    if (photo && photo.type === 'photo' && photo.contributedViaAlbum === album.token) {
      await destroyShareManagedData(photo);
      detachActiveShare(photo);
    }
  } catch (e) {
    console.error('[album] contributed image purge failed:', e && e.message);
    return res.status(500).json({ error:'delete-failed' });
  }
  // destroyShareManagedData already removes album references for a managed photo;
  // this filter also handles a stale member token whose photo record is gone.
  album.members = (album.members || []).filter((t) => t !== token);
  if (!persistNow()) return res.status(503).json({ error:'write-error', persisted:false });
  try { scheduleSearchReindex(); } catch (_) {}
  res.json({ ok: true, persisted:true });
});

// Rendered preview (Markdown, highlighted code, ZIP listing) for an
// indexed item of a file/collection share. Falls back to the raw /view otherwise.
downloadRouter.get('/s/:token/render', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type === 'web-storage') return res.redirect(302, `/s/${req.params.token}/view`);
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const items = shareItems(s) || [];
  if (!items.length) return sendError(req, res, 404, 'fileUnavailable');
  const idx = clampIndex(req.query.i, items.length);
  const item = items[idx];
  if (!item) return sendError(req, res, 404, 'fileUnavailable');
  if (s.noPreview) return res.redirect(302, `/s/${req.params.token}/download?i=${idx}`);
  const kind = renderKind(item.name);
  if (!kind) return res.redirect(302, `/s/${req.params.token}/view?i=${idx}`);
  try {
    const abs = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, abs);
    const viewUrl = previewInfo(item.name) ? `/s/${req.params.token}/view?i=${idx}` : '';
    const html = await buildRenderPage(pickLang(req), s.name, item.name, abs, kind, `/s/${req.params.token}/download?i=${idx}`, viewUrl);
    res.type('html').send(html);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

// Whether "download everything as .zip" is allowed for this share (default: yes).

downloadRouter.get('/s/:token/all.zip', async (req, res) => {
  const s = requireActiveShare(req, res, { countDownload: true });
  if (!s) return;
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  const items = shareItems(s);
  streamZipFiles(req, res, items, s.name || 'files', () => incrementDownloads(s.id), {
    shareId: s.id,
    name: s.name || 'files',
    type: 'collection-zip',
  });
});

// --- Folder serving, shared by top-level folder shares and folder items inside a
//     collection. `base` is the URL prefix used to build links (`/s/<t>` or
//     `/s/<t>/item/<i>`); `label` is the folder name shown in the header. ---
async function serveFolderBrowse(req, res, s, folderRoot, sub, base, label) {
  const absDir = resolveWithin(folderRoot, sub);
  await assertRealWithin(folderRoot, absDir);
  const st = await fs.promises.stat(absDir);
  if (!st.isDirectory()) {
    if (!downloadAllowed(req, res, s)) return;
    return streamFile(req, res, absDir, path.basename(absDir), () => incrementDownloads(s.id), {
      shareId: s.id,
      name: path.basename(absDir),
      type: 'file',
    }, { challenge: true });
  }
  const entries = await listDir(absDir, folderRoot);
  const browseBase = `${base}/browse`;
  const joinRel = (child) => (sub ? sub.replace(/\/+$/, '') + '/' + child : child);
  const links = {
    browseBase,
    browse: (rel) => `${browseBase}/${encodePath(rel)}`,
    file: (rel) => `${base}/file/${encodePath(rel)}`,
    zip: (rel) => (rel ? `${base}/zip/${encodePath(rel)}` : `${base}/zip`),
    sha256: (rel) => (rel ? `${base}/sha256/${encodePath(rel)}` : `${base}/sha256`),
  };
  const withRel = entries.map((e) => ({ ...e, rel: joinRel(e.name) }));
  const view = label && label !== s.name ? { ...s, name: label } : s;
  const wm = previewWatermark(req, req.params.token);
  // ?player=1 opens a playlist player for the audio/video in this folder.
  if (req.query.player && !s.noPreview) {
    return res.type('html').send(mediaPlayerPage(pickLang(req), view, withRel, links, wm));
  }
  res.type('html').send(folderPage(pickLang(req), view, sub, withRel, links, wm));
}

function editRelativeQuery(rawUrl, changes) {
  const raw = String(rawUrl || '');
  const q = raw.indexOf('?');
  const pathname = q >= 0 ? raw.slice(0, q) : raw;
  const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  for (const [key, value] of Object.entries(changes || {})) {
    if (value == null) params.delete(key); else params.set(key, String(value));
  }
  const query = params.toString();
  return pathname + (query ? '?' + query : '');
}

async function serveFolderFile(req, res, s, folderRoot, sub) {
  const abs = resolveWithin(folderRoot, sub);
  await assertRealWithin(folderRoot, abs);
  const name = path.basename(abs);
  // ?vtt=1 serves a sibling subtitle as WebVTT (converting .srt).
  if (req.query.vtt) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'vtt' || ext === 'srt') {
      let raw = '';
      // Subtitles are small; cap the read so a huge misnamed .srt can't OOM us.
      try { raw = (await readFileCapped(abs, SUBTITLE_MAX_BYTES)).buf.toString('utf8'); }
      catch (_) { return sendError(req, res, 404, 'fileNotFound'); }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(ext === 'srt' ? srtToVtt(raw) : (/^﻿?WEBVTT/.test(raw) ? raw : 'WEBVTT\n\n' + raw));
    }
  }
  // ?render=1 shows a rendered preview (Markdown / highlighted code / ZIP list).
  if (req.query.render && !s.noPreview) {
    const kind = renderKind(name);
    if (kind) {
      const downloadUrl = editRelativeQuery(req.originalUrl, { render:null, view:null });
      const viewUrl = previewInfo(name) ? editRelativeQuery(req.originalUrl, { render:null, view:'1' }) : '';
      const html = await buildRenderPage(pickLang(req), s.name, name, abs, kind, downloadUrl, viewUrl);
      return res.type('html').send(html);
    }
  }
  // ?view=1 serves the file inline (gallery thumbnail / open-in-tab preview) and
  // is NOT counted as a download or tracked as a transfer — mirrors /s/:token/view.
  const info = req.query.view && !s.noPreview ? previewInfo(name) : null;
  if (info) {
    if (info.kind === 'pdf') { res.setHeader('X-Frame-Options','SAMEORIGIN'); res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); }
    return streamFile(req, res, abs, name, null, null, { inline: true, contentType: info.contentType });
  }
  if (!downloadAllowed(req, res, s)) return;
  streamFile(req, res, abs, name, () => incrementDownloads(s.id), {
    shareId: s.id,
    name: String(sub || name).replace(/\\/g, '/'),
    type: 'file',
  }, { challenge: true });
}

async function serveFolderZip(req, res, s, folderRoot, sub, label) {
  if (challengeGateZip(req, res)) return;
  const absDir = resolveWithin(folderRoot, sub);
  await assertRealWithin(folderRoot, absDir);
  const st = await fs.promises.stat(absDir);
  if (!st.isDirectory()) return sendError(req, res, 404, 'folderNotFound');
  const zipName = sub ? path.basename(absDir) : label;
  streamZip(req, res, absDir, zipName, () => incrementDownloads(s.id), {
    shareId: s.id,
    name: zipName,
    type: 'zip',
  });
}

// --- SHA-256 integrity manifests ---------------------------------
// Streaming SHA-256 of one file (no size limit, constant memory).
function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs);
    rs.on('error', reject);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
// Collects { rel, abs } for every file under rootAbs (recursively). `baseRel`
// prefixes the relative paths (so a folder item keeps its name in the manifest).
async function collectFiles(rootAbs, baseRel) {
  const out = [];
  async function walk(dir, rel) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) out.push({ rel: r, abs });
    }
  }
  await walk(rootAbs, baseRel || '');
  return out;
}
// Sends a `sha256sum`-compatible manifest ("<hex>  <path>\n") as a download, so
// the recipient can verify integrity after transfer (e.g. `sha256sum -c`).
async function sendSha256Manifest(res, files, downloadName) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  let out = '';
  for (const f of files) {
    try { out += `${await sha256File(f.abs)}  ${f.rel}\n`; } catch (_) {}
  }
  res.send(out || '# no files\n');
}
// Builds the file list backing a share (files + recursively-walked folders).
async function shareManifestFiles(s, folderRoot, sub) {
  if (folderRoot != null) {
    const absDir = resolveWithin(folderRoot, sub || '');
    await assertRealWithin(folderRoot, absDir);
    return collectFiles(absDir, '');
  }
  // file / collection share
  const items = shareItems(s) || [];
  const files = [];
  for (const it of items) {
    const abs = hostToContainer(it.hostPath);
    try {
      // Re-resolve symlinks at request time. A host path that was safe when the
      // share was created can later be replaced by a symlink outside HOST_ROOT.
      const real = await assertRealWithin(HOST_ROOT, abs);
      if ((await fs.promises.stat(real)).isDirectory()) files.push(...(await collectFiles(real, it.name)));
      else files.push({ rel: it.name, abs: real });
    } catch (_) {}
  }
  return files;
}

// Turns a list of selected relative paths (under folderRoot) into
// zip items. Each path is validated to stay within the root; missing entries are
// silently skipped. Capped to avoid abuse.
async function selectionToItems(folderRoot, rels) {
  const items = [], seen = new Set();
  let realRoot;
  try { realRoot = await fs.promises.realpath(folderRoot); } catch (_) { return items; }
  for (const relRaw of (Array.isArray(rels) ? rels : []).slice(0, ZIP_SELECTION_MAX)) {
    if (typeof relRaw !== 'string' || !relRaw) continue;
    const requested = relRaw.replace(/\\/g,'/').replace(/^\/+/, '');
    if (!requested) continue;
    let abs;
    try { abs = resolveWithin(folderRoot, requested); abs = await assertRealWithin(realRoot, abs); } catch (_) { continue; }
    const rel = path.relative(realRoot, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('../') || seen.has(rel)) continue;
    let st; try { st = await fs.promises.stat(abs); } catch (_) { continue; }
    seen.add(rel);
    // Keep the validated container path/root for writable collaboration trees.
    // Converting those through HOST_ROOT would incorrectly point at /host/... .
    items.push({ containerPath: abs, allowedRoot: realRoot, name: rel, size: st.isFile() ? st.size : null, type: st.isDirectory() ? 'folder' : 'file' });
  }
  return items;
}
function parseSelList(v) { return String(v || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, ZIP_SELECTION_MAX); }
function parseIndexList(v, max) { const out=[], seen=new Set(); for (const raw of parseSelList(v)) { if (!/^\d+$/.test(raw)) continue; const n=Number(raw); if (!Number.isSafeInteger(n)||n<0||n>=max||seen.has(n)) continue; seen.add(n); out.push(n); if(out.length>=ZIP_SELECTION_MAX)break; } return out; }
const ZIP_SELECTION_MAX = 2000;
const selParser = express.urlencoded({ extended: false, limit: '512kb' });

// Resolves a folder item of a collection from :idx; sends 404 and returns null
// if the share isn't a collection or the item isn't a folder.
function collectionFolderItem(req, res, s) {
  const items = shareItems(s);
  const idx = clampIndex(req.params.idx, items ? items.length : 0);
  const item = items && items[idx];
  if (!item || item.type !== 'folder') {
    sendError(req, res, 404, 'notFound');
    return null;
  }
  return { item, idx };
}

downloadRouter.get(['/s/:token/browse', '/s/:token/browse/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type === 'web-storage') {
    const meta = webStorageShareMeta(s);
    if (!meta || !meta.isDir) return sendError(req, res, 404, 'notFound');
    const rel = cleanConnectorPath(req.params[0] || '');
    if (rel === null) return sendError(req, res, 404, 'notFound');
    try {
      const entries = await webStorageList(s, rel);
      const base = `/s/${req.params.token}/browse`;
      const links = {
        browseBase:base,
        browse:(p) => base + (p ? '/' + encodePath(p) : ''),
        file:(p) => `/s/${req.params.token}/file/${encodePath(p)}`,
      };
      return res.type('html').send(webStorageFolderPage(pickLang(req), s, rel, entries, links, previewWatermark(req, req.params.token)));
    } catch (e) {
      const code = connectorErrorCode(e);
      return sendError(req, res, (code === 'remote-not-found' || code === 'connector-not-found') ? 404 : 503, 'folderUnavailable');
    }
  }
  if (s.type !== 'folder') return sendError(req, res, 404, 'notFound');
  try {
    await serveFolderBrowse(req, res, s, hostToContainer(s.hostPath), req.params[0] || '', `/s/${req.params.token}`, s.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

downloadRouter.get('/s/:token/file/*', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type === 'web-storage') {
    const meta = webStorageShareMeta(s);
    if (!meta || !meta.isDir) return sendError(req, res, 404, 'notFound');
    const rel = cleanConnectorPath(req.params[0], false);
    if (rel === null) return sendError(req, res, 404, 'notFound');
    try {
      const stat = await webStorageStat(s, rel);
      if (stat.isDir) return res.redirect(302, `/s/${req.params.token}/browse/${encodePath(rel)}`);
      const inlineRequested = req.query.view === '1' || req.query.render === '1';
      const info = inlineRequested && !s.noPreview ? previewInfo(stat.name) : null;
      if (inlineRequested && !info) return res.redirect(302, `/s/${req.params.token}/file/${encodePath(rel)}`);
      if (inlineRequested && info.kind === 'pdf') { res.setHeader('X-Frame-Options','SAMEORIGIN'); res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); }
      if (!info && !downloadAllowed(req, res, s)) return;
      return serveWebStorageFile(req, res, s, rel, {
        filename:stat.name,
        inline:!!info,
        contentType:info && info.contentType,
        challenge:!info,
      });
    } catch (e) {
      const code = connectorErrorCode(e);
      return sendError(req, res, (code === 'remote-not-found' || code === 'connector-not-found') ? 404 : 503, 'fileUnavailable');
    }
  }
  if (s.type !== 'folder') return sendError(req, res, 404, 'notFound');
  try {
    await serveFolderFile(req, res, s, hostToContainer(s.hostPath), req.params[0] || '');
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

downloadRouter.get(['/s/:token/zip', '/s/:token/zip/*'], async (req, res) => {
  const s = requireActiveShare(req, res, { countDownload: true });
  if (!s) return;
  if (s.type !== 'folder') return sendError(req, res, 404, 'notFound');
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  try {
    await serveFolderZip(req, res, s, hostToContainer(s.hostPath), req.params[0] || '', s.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// SHA-256 checksum manifest for a download share (file, collection or folder).
downloadRouter.get(['/s/:token/sha256', '/s/:token/sha256/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type === 'web-storage') return sendError(req, res, 404, 'notFound');
  try {
    const files = s.type === 'folder'
      ? await shareManifestFiles(s, hostToContainer(s.hostPath), req.params[0] || '')
      : await shareManifestFiles(s, null);
    await sendSha256Manifest(res, files, (s.name || 'files') + '.sha256');
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// Download a selection of files as one .zip (folder or collection).
downloadRouter.post('/s/:token/zip-select', selParser, async (req, res) => {
  const s = requireActiveShare(req, res, { countDownload: true }); // ZIP-of-selection is a real download
  if (!s) return;
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  try {
    let items = [];
    if (s.type === 'folder') {
      items = await selectionToItems(hostToContainer(s.hostPath), parseSelList(req.body.sel).slice(0, ZIP_SELECTION_MAX));
    } else if (s.type === 'file') {
      const all = shareItems(s) || [];
      items = parseIndexList(req.body.idx, all.length)
        .map((n) => all[n]).filter(Boolean)
        .map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }));
    } else {
      return sendError(req, res, 404, 'notFound');
    }
    if (!items.length) return sendError(req, res, 400, 'notFound');
    return streamZipFiles(req, res, items, (s.name || 'selection'), () => incrementDownloads(s.id),
      { shareId: s.id, name: `${s.name || 'selection'} (${items.length} selected)`, type: 'collection-zip' });
  } catch (e) {
    console.error('[download] selected ZIP failed:', e && e.message);
    if (!res.headersSent) return sendError(req, res, e && e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// --- Folder items inside a collection (a `file`-type share with folder items) ---
downloadRouter.get(['/s/:token/item/:idx/browse', '/s/:token/item/:idx/browse/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const r = collectionFolderItem(req, res, s);
  if (!r) return;
  try {
    await serveFolderBrowse(req, res, s, hostToContainer(r.item.hostPath), req.params[0] || '', `/s/${req.params.token}/item/${r.idx}`, r.item.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

downloadRouter.get('/s/:token/item/:idx/file/*', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const r = collectionFolderItem(req, res, s);
  if (!r) return;
  try {
    await serveFolderFile(req, res, s, hostToContainer(r.item.hostPath), req.params[0] || '');
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

downloadRouter.get(['/s/:token/item/:idx/zip', '/s/:token/item/:idx/zip/*'], async (req, res) => {
  const s = requireActiveShare(req, res, { countDownload: true }); // item folder ZIP is a real download
  if (!s) return; // requireActiveShare already sent the response
  if (s.type !== 'file') return sendError(req, res, 404, 'notFound');
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  const r = collectionFolderItem(req, res, s);
  if (!r) return;
  try {
    await serveFolderZip(req, res, s, hostToContainer(r.item.hostPath), req.params[0] || '', r.item.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// --- Burn-after-read secret notes (/x/:token) --------------------
const SECRET_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
// Returns the live metadata for a secret, lazily purging it if expired.
function secretMeta(token) {
  if (!SECRET_TOKEN_RE.test(String(token || ''))) return null;
  const state = getState();
  const m = state && state.meta && state.meta.secrets;
  const rec = m && m[token];
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) { destroySecret(token); return null; }
  return rec;
}
// Removes a secret's ciphertext and metadata (the "burn"). The physical
// ciphertext is the authority for one-time delivery: never erase the only retry
// metadata while the file still exists because of a transient filesystem error.
function destroySecret(token) {
  if (!SECRET_TOKEN_RE.test(String(token || ''))) return false;
  const state = getState();
  const file = path.join(SECRETS_DIR, token + '.dxe');
  try { fs.unlinkSync(file); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') {
      console.error('[secret] ciphertext delete failed:', e && e.message);
      return false;
    }
  }
  if (state.meta && state.meta.secrets && state.meta.secrets[token]) {
    delete state.meta.secrets[token];
    // A failed metadata flush cannot resurrect readable data because the ciphertext
    // has already been physically removed. Keep the failure visible in diagnostics.
    if (!persistNow()) console.error('[secret] metadata flush failed after burn');
  }
  return true;
}
downloadRouter.get('/x/:token', (req, res) => {
  const meta = secretMeta(req.params.token);
  if (!meta) return sendError(req, res, 404, 'secretGone');
  res.type('html').send(secretPage(pickLang(req), req.params.token, meta.mode));
});
// Hands out the ciphertext exactly once, then burns it. The whole handler is
// synchronous (no await) so two racing requests can't both read the secret.
downloadRouter.get('/x/:token/blob', (req, res) => {
  const token = req.params.token;
  const meta = secretMeta(token);
  if (!meta) return res.status(404).json({ error: 'gone' });
  let buf = null;
  try { buf = fs.readFileSync(path.join(SECRETS_DIR, token + '.dxe')); } catch (_) {}
  if (!buf) { destroySecret(token); return res.status(404).json({ error: 'gone' }); }
  // Do not hand out the secret unless the ciphertext has first been made physically
  // unreadable for a second request. A transient unlink failure is retryable.
  if (!destroySecret(token)) return res.status(503).json({ error: 'burn-failed' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

// Delete a file/subfolder from the collab folder — only when the link allows it.
// Unlocking a password-protected link (form on the access page).
const unlockParser = express.urlencoded({ extended: false, limit: '4kb' });
async function unlockHandler(req, res) {
  const s = getByToken(req.params.token);
  if (!s || !isActive(s)) return sendError(req, res, 404, 'shareGone');
  // Redirect back to the token the visitor is actually on (main link or a
  // nominative sub-link), so a recipient stays on their own sub-link and their
  // downloads keep being attributed to them.
  const rel = linkPrefix(s) + req.params.token;
  if (!s.pwHash) return res.redirect(302, rel);

  // Brute-force state and async verification serialization are owned by the
  // public access service so every public-link password flow uses one policy.
  const attempt = beginUnlockAttempt(req);
  const ip = attempt.ip;
  if (!attempt.ok) {
    if (attempt.retryAfter) res.setHeader('Retry-After', String(attempt.retryAfter));
    return res.status(429).type('html').send(passwordPage(pickLang(req), s, true, req.params.token));
  }
  try {
    const entered = String((req.body && req.body.password) || '');
    const passwordCheck=await checkSharePassword(s,entered); if(!passwordCheck.ok)return sendPasswordWorkHtml(req,res,passwordCheck.error);
    if(!passwordCheck.match){
      const failure = noteUnlockFailure(attempt, authService.lockMs());
      const failureAt = failure.at;
      const failedCount = failure.failedCount;
      const willLock = failure.locked;
      if (failedCount >= 3) {
        const geo = geoSync(ip) || {};
        addShareCenterNotification(s, 'password-failures', { ip:pubIp(ip), country:geo.country || null, flag:geo.flag || flagFromCode(geo.countryCode) || '🌐', count:failedCount, reason:willLock ? 'locked' : 'failed', dedupeKey:`password-failures:${s.id}:${maskIp(ip)}:${Math.floor(failureAt/(15*60000))}` });
      }
      return res.status(401).type('html').send(passwordPage(pickLang(req), s, true, req.params.token));
    }
    const successAt = Date.now();
    const { previousFailures } = noteUnlockSuccess(attempt);
    const geoOk = geoSync(ip) || {};
    if (!s.centerProtectedFirstAccessAt) {
      s.centerProtectedFirstAccessAt = successAt;
      addShareCenterNotification(s, 'protected-link-first-access', { ip:pubIp(ip), country:geoOk.country||null, flag:geoOk.flag||flagFromCode(geoOk.countryCode)||'🌐', dedupeKey:`protected-first:${s.id}` });
      scheduleFlush();
    }
    if (previousFailures > 0) addShareCenterNotification(s, 'password-recovered', { ip:pubIp(ip), count:previousFailures, country:geoOk.country||null, flag:geoOk.flag||flagFromCode(geoOk.countryCode)||'🌐', dedupeKey:`password-recovered:${s.id}:${maskIp(ip)}:${Math.floor(successAt/(15*60000))}`, dedupeWindowMs:15*60000 });
    // Upgrade a legacy SHA-256 link hash to scrypt on first successful unlock.
    if (await upgradeLegacySharePassword(s, entered)) scheduleFlush();
    setUnlockCookie(req, res, s);
    return res.redirect(302, rel);
  } catch (e) {
    // Express 4 does not automatically consume rejected promises from async
    // handlers. Keep password/KDF failures contained in the request instead of
    // allowing an unhandled rejection to terminate or destabilize the process.
    console.error('[unlock] password verification failed:', e && e.message);
    if (!res.headersSent) return sendPasswordWorkHtml(req, res, 'scrypt-failed');
  } finally {
    finishUnlockAttempt(attempt);
  }
}
downloadRouter.post('/s/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/u/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/c/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/i/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/g/:token/unlock', unlockParser, unlockHandler);

// A visitor submits the access-request form on a locked link. Creates
// one pending request per browser (tracked by cookie) and pings the admin. Plain
// form POST + redirect, so it works without JavaScript.
const requestAccessParser = express.urlencoded({ extended: false, limit: '8kb' });
downloadRouter.post(['/s/:token/request-access', '/u/:token/request-access', '/c/:token/request-access', '/i/:token/request-access', '/g/:token/request-access'], requestAccessParser, (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || !isActive(s) || !s.requestAccess) return sendError(req, res, 404, 'shareGone');
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, req.params.token));
  const rel = linkPrefix(s) + req.params.token;
  // Already tracked on this browser (pending/approved/denied) — don't pile up duplicates.
  if (pendingAccessRequest(req, s)) return res.redirect(302, rel);
  const name = String((req.body && req.body.name) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const email = String((req.body && req.body.email) || '').replace(/[\r\n\t ]+/g, '').trim().slice(0, 200);
  const message = String((req.body && req.body.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  if (!name) return res.status(400).type('html').send(accessRequestPage(pickLang(req), s, req.params.token, null));
  const decisionSnapshot = snapshotPublicMessageDecision(req, s.token);
  const decision = publicMessageDecision(req, s.token, name + '\n' + email + '\n' + message, 'access-request');
  if (decision.retryAfter) {
    res.setHeader('Retry-After', String(decision.retryAfter));
    return res.status(429).type('html').send(errorPage(pickLang(req), 429, (PUB[pickLang(req)] || PUB.en).tooManyReq));
  }
  const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
  // A client may retry after the original redirect/cookie response was lost. The
  // anti-abuse layer already recognizes that payload as a duplicate; reuse the
  // existing pending request instead of creating another durable row.
  if (decision.duplicate) {
    const prior = Array.isArray(s.accessRequests) ? s.accessRequests.find((row) => row && row.status === 'pending' &&
      String(row.ip || '') === ip && String(row.name || '') === name && String(row.email || '') === email &&
      String(row.message || '') === message && (Date.now() - (Number(row.at) || 0)) < PUBLIC_MESSAGE_DUP_MS) : null;
    if (prior && prior.id) {
      setAccessRequestCookie(req, res, s, prior.id);
      return res.redirect(302, rel);
    }
    // The anti-spam cache may outlive a trimmed/restored durable row. Do not turn
    // that stale cache entry into a silent request drop.
  }
  const geo = geoSync(ip) || {};
  const previousRequests = Array.isArray(s.accessRequests) ? JSON.parse(JSON.stringify(s.accessRequests)) : null;
  if (!Array.isArray(s.accessRequests)) s.accessRequests = [];
  const id = crypto.randomBytes(12).toString('hex');
  s.accessRequests.unshift({ id, name, email: email || null, message: message || null, at: Date.now(), ip, country: geo.country || null, flag: geo.flag || '🌐', status: 'pending', decidedAt: 0, decidedBy: null });
  if (s.accessRequests.length > ACCESS_REQUESTS_MAX) s.accessRequests.length = ACCESS_REQUESTS_MAX;
  if (!persistNow()) {
    if (previousRequests) s.accessRequests = previousRequests; else delete s.accessRequests;
    restorePublicMessageDecision(decisionSnapshot);
    return res.status(503).type('html').send(errorPage(pickLang(req), 503, 'Unable to save this request. Please retry.'));
  }
  geolocate(ip).catch(() => {});
  setAccessRequestCookie(req, res, s, id);
  emitLiveActivity('visitor', { shareId:s.id, name:s.name, status:'access-request', detail:'access request submitted', ip:pubIp(ip) });
  if (decision.notify) notify('message', { name: s.name, shareId: s.id, ip, country: geo.country, text: `Access request — ${name}${email ? ` <${email}>` : ''}${message ? `: ${message}` : ''}`, file: null });
  res.redirect(302, rel);
});

// A visitor leaves moderated feedback on a shared file. Private to the
// admin (never shown to other visitors). Plain form POST + redirect (no JS needed).
const feedbackParser = express.urlencoded({ extended: false, limit: '8kb' });
downloadRouter.post('/s/:token/feedback', feedbackParser, (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || !isActive(s) || !s.allowFeedback) return sendError(req, res, 404, 'shareGone');
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, req.params.token));
  if (s.requestAccess && !isAccessApproved(req, s)) return res.status(401).type('html').send(accessRequestPage(pickLang(req), s, req.params.token, pendingAccessRequest(req, s)));
  const rel = linkPrefix(s) + req.params.token;
  // Return the visitor to the page they were on (same share only, to avoid an open
  // redirect), with a flag the page uses to show a thank-you note.
  let back = rel;
  try { const u = new URL(String(req.get('referer') || ''), primaryBase(req)); if (u.pathname.startsWith(linkPrefix(s) + req.params.token)) back = u.pathname; } catch (_) {}
  const name = String((req.body && req.body.name) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const body = String((req.body && req.body.body) || '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (!body) return res.redirect(302, back);
  const decisionSnapshot = snapshotPublicMessageDecision(req, s.token);
  const decision = publicMessageDecision(req, s.token, body, 'feedback');
  if (decision.retryAfter) {
    res.setHeader('Retry-After', String(decision.retryAfter));
    return res.status(429).type('html').send(errorPage(pickLang(req), 429, (PUB[pickLang(req)] || PUB.en).fbError || 'Please wait a moment and retry.'));
  }
  if (!decision.duplicate) {
    const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
    const geo = geoSync(ip) || {};
    const previousFeedback = Array.isArray(s.visitorFeedback) ? JSON.parse(JSON.stringify(s.visitorFeedback)) : null;
    if (!Array.isArray(s.visitorFeedback)) s.visitorFeedback = [];
    s.visitorFeedback.unshift({ id: crypto.randomBytes(8).toString('hex'), at: Date.now(), ip, country: geo.country || null, flag: geo.flag || '🌐', name: name || null, body, read: false });
    if (s.visitorFeedback.length > VISITOR_FEEDBACK_MAX) s.visitorFeedback.length = VISITOR_FEEDBACK_MAX;
    if (!persistNow()) {
      if (previousFeedback) s.visitorFeedback = previousFeedback; else delete s.visitorFeedback;
      restorePublicMessageDecision(decisionSnapshot);
      return res.status(503).type('html').send(errorPage(pickLang(req), 503, 'Unable to save this feedback. Please retry.'));
    }
    geolocate(ip).catch(() => {});
    emitLiveActivity('visitor', { shareId:s.id, name:s.name, status:'feedback', detail:name ? 'feedback submitted · ' + name : 'feedback submitted', ip:pubIp(ip) });
    if (decision.notify) notify('message', { name: s.name, shareId: s.id, ip, country: geo.country, text: `Feedback${name ? ` — ${name}` : ''}: ${body}`, file: null });
  }
  res.redirect(302, back + (back.includes('?') ? '&' : '?') + 'feedback=sent');
});

  return {
    downloadRouter,
    albumInviteHash,
    listDir,
    parseHotlinkHosts,
    parseSelList,
    selectionToItems,
    serveFolderFile,
    serveFolderZip,
    shareManifestFiles,
    sendSha256Manifest,
    selParser,
    RENDER_MAX_BYTES,
    ZIP_SELECTION_MAX,
  };
}

module.exports = { createPublicShareRoutes };
