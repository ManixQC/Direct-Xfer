'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

/**
 * Upload/reception domain service.
 *
 * Owns reception quotas and accounting, resumable upload staging, moderation,
 * antivirus/quarantine gates, duplicate tracking, upload concurrency state and
 * cross-share deduplication primitives. HTTP route composition stays outside
 * this module. Mutable application state is accessed through `live` so restore
 * operations cannot leave the service holding stale store bindings.
 */
function createUploadReceptionService(deps = {}) {
  const {
    APP_NAME,
    CLAMAV_HOST,
    CLAMAV_PORT,
    DATA_DIR,
    FULL_IMAGES_DIR,
    INBOX_DIR,
    MAX_CONCURRENT_UPLOADS,
    RECEPTION_THREAD_MAX = 200,
    QUARANTINE_DIR,
    UPLOAD_IDLE_TIMEOUT_MS,
    addShareCenterNotification,
    assertRealWithin,
    clamavEnabled,
    clientIp,
    closeFd,
    dispatch,
    emitInboxEvent,
    emitLiveActivity,
    endTransfer,
    evaluateCustomNotificationRulesForShare,
    getSettings,
    hashFileSha256,
    logAudit,
    maskIp,
    maybeCenterReceptionQuota,
    notificationAccountIdForShare,
    notificationAdminAccountIds,
    openFd,
    persistNow,
    pubIp,
    readFd,
    resolveWithin,
    restorePlainObject,
    scheduleFlush,
    scheduleSearchReindex,
    live,
  } = deps;

  if (!live || typeof live !== 'object') throw new TypeError('upload-reception-service requires live bindings');

  // --- File reception (reception links) ---

  // Two-way reception thread projection/accounting is part of the reception
  // domain, not route composition. Sanitize restored records at the boundary so
  // one corrupt message cannot break the public/admin thread endpoints.
  const receptionThreadLimit = (() => {
    const n = Number(RECEPTION_THREAD_MAX);
    return Number.isFinite(n) && n > 0 ? Math.min(10000, Math.floor(n)) : 200;
  })();
  function validReceptionThreadMessage(m) {
    return !!m && typeof m === 'object' && !Array.isArray(m) && (m.from === 'owner' || m.from === 'visitor');
  }
  function receptionThreadArray(s) {
    return Array.isArray(s && s.thread) ? s.thread.filter(validReceptionThreadMessage) : [];
  }
  function receptionThreadEnabled(s) { return !!(s && s.type === 'inbox' && s.threadDisabled !== true); }
  function cleanThreadText(value, max = 4000) {
    return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').slice(0, max) : '';
  }
  function cleanThreadLine(value, max) {
    return typeof value === 'string' ? value.replace(/[\r\n\t\u0000]+/g, ' ').trim().slice(0, max) : '';
  }
  function finiteThreadTime(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  function publicThreadMessage(m) {
    if (!validReceptionThreadMessage(m)) return null;
    return {
      id:cleanThreadLine(m.id, 128), at:finiteThreadTime(m.at), from:m.from,
      name:m.from === 'owner' ? null : (cleanThreadLine(m.name, 120) || null),
      text:cleanThreadText(m.text),
    };
  }
  function ownerThreadMessage(m) {
    if (!validReceptionThreadMessage(m)) return null;
    return {
      id:cleanThreadLine(m.id, 128), at:finiteThreadTime(m.at), from:m.from,
      name:cleanThreadLine(m.name, 120) || null, text:cleanThreadText(m.text),
      ip:cleanThreadLine(m.ip, 160) || null, country:cleanThreadLine(m.country, 120) || null,
      flag:cleanThreadLine(m.flag, 32) || null, read:m.read !== false,
    };
  }
  function appendReceptionThreadMessage(s, msg) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || !validReceptionThreadMessage(msg)) return false;
    const current = receptionThreadArray(s);
    current.push(msg);
    s.thread = current.slice(-receptionThreadLimit);
    return true;
  }
  function receptionThreadUnreadCount(s) {
    return receptionThreadArray(s).reduce((n, m) => n + (m.from === 'visitor' && m.read === false ? 1 : 0), 0);
  }

  function collabRoot(s) { return resolveWithin(INBOX_DIR, s.relDir || ''); }

  async function folderMetrics(dir) {
    let bytes = 0, files = 0;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return { bytes:0, files:0 }; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const nested = await folderMetrics(p); bytes += nested.bytes; files += nested.files; }
      else if (e.isFile()) { try { bytes += (await fs.promises.stat(p)).size; files += 1; } catch (_) {} }
    }
    return { bytes, files };
  }
  async function folderBytes(dir) { return (await folderMetrics(dir)).bytes; }
  function acceptsUpload(s) { return !!s && (s.type === 'inbox' || s.type === 'collab'); }

  function safeUploadName(name) {
    let n = String(name || '').replace(/\\/g, '/');
    n = n.split('/').pop() || ''; // basename only
    n = n
      .split('')
      .filter((ch) => ch.charCodeAt(0) >= 32)
      .join('');
    n = n.replace(/^\.+/, '').trim();
    if (!n || n === '.' || n === '..') n = 'file';
    if (n.length > 200) n = n.slice(-200);
    return n;
  }

  // Normalizes an extension list (array or "jpg, png ..." string) to lowercase
  // bare extensions (no dot, alphanumerics only), de-duplicated and capped.
  function normExtList(v) {
    const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
    const out = [];
    for (let e of arr) {
      e = String(e || '').trim().toLowerCase().replace(/^\*?\.?/, '').replace(/[^a-z0-9]/g, '');
      if (e && !out.includes(e)) out.push(e);
      if (out.length >= 40) break;
    }
    return out;
  }

  // Extension (lowercase, no dot) of a filename/relative path, '' if none.
  function fileExt(name) {
    const b = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  }

  // Reception-link quota/filter gate. Returns null when allowed, otherwise an
  // error code. sizeHint is the announced size (Content-Length); 0 if unknown.
  // Sanitized visitor name for a reception deposit. Reused for the
  // optional per-sender subfolder AND the "require a name" gate.
  function cleanSenderName(req) {
    return String((req && req.query && req.query.sender) || '')
      .replace(/[^\p{L}\p{N} _.-]/gu, '_').replace(/^\.+/, '').trim().slice(0, 60);
  }
  // Leading-byte content sniff. Detects native executables (Windows
  // PE, ELF, Mach-O / Java class / universal binaries) and shell shebangs so a link
  // with `blockExecutables` refuses a disguised binary even when the extension
  // filter would accept it (e.g. malware renamed to .jpg).
  function sniffExecutable(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';                 // MZ (EXE/DLL)
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf';
    if (buf[0] === 0x23 && buf[1] === 0x21) return 'script';            // #! shebang
    const u32 = buf.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(u32)) return 'macho';
    return null;
  }
  async function inboxContentReason(s, absPath) {
    if (!s || !s.blockExecutables) return null;
    let fd = null;
    try {
      fd = await openFd(absPath, 'r');
      const buf = Buffer.alloc(8);
      const { bytesRead } = await readFd(fd, buf, 0, 8, 0);
      if (sniffExecutable(buf.subarray(0, bytesRead))) return 'content-blocked';
    } catch (_) {}
    finally { if (fd !== null) try { await closeFd(fd); } catch (_) {} }
    return null;
  }
  // Server-wide reception storage cap. Per-link quotas (maxTotalBytes)
  // already exist; this bounds the TOTAL bytes received across every reception /
  // collaboration link, protecting the writable /Direct-Xfer volume. 0 = unlimited.
  function receptionStorageCapBytes() {
    const gb = Number(getSettings().receptionStorageCapGB) || 0;
    return gb > 0 ? Math.round(gb * 1024 * 1024 * 1024) : 0;
  }
  function pendingModerationRows() {
    return (live.state.meta && Array.isArray(live.state.meta.pending)) ? live.state.meta.pending : [];
  }
  function pendingUsageForShare(s, excludePendingId = null) {
    let files = 0, bytes = 0;
    if (!s || !s.id) return { files, bytes };
    for (const row of pendingModerationRows()) {
      if (!row || row.shareId !== s.id || (excludePendingId && row.id === excludePendingId)) continue;
      files += 1;
      bytes += Math.max(0, Number(row.size) || 0);
    }
    return { files, bytes };
  }
  function pendingUsageForSender(s, senderKey, excludePendingId = null) {
    let files = 0, bytes = 0;
    if (!s || !s.id || !senderKey) return { files, bytes };
    for (const row of pendingModerationRows()) {
      if (!row || row.shareId !== s.id || row.senderKey !== senderKey || (excludePendingId && row.id === excludePendingId)) continue;
      files += 1;
      bytes += Math.max(0, Number(row.size) || 0);
    }
    return { files, bytes };
  }
  function pendingReceptionBytes(excludePendingId = null) {
    let total = 0;
    for (const row of pendingModerationRows()) {
      if (!row || (excludePendingId && row.id === excludePendingId)) continue;
      total += Math.max(0, Number(row.size) || 0);
    }
    return total;
  }
  function currentReceptionBytes(excludePendingId = null) {
    let total = 0;
    // Active links and recoverable-trash links both retain managed reception bytes on
    // disk. Ignoring trash made the global storage cap reopen immediately after a
    // revocation even though the files were still consuming the same volume.
    for (const s of live.state.shares) if (s && !s.webStorage && (s.type === 'inbox' || s.type === 'collab')) total += Math.max(0, Number(s.bytesReceived) || 0);
    for (const rec of (Array.isArray(live.state.trash) ? live.state.trash : [])) {
      const s = rec && rec.share;
      if (s && !s.webStorage && (s.type === 'inbox' || s.type === 'collab')) total += Math.max(0, Number(s.bytesReceived) || 0);
    }
    // Moderated uploads already occupy .dxpending and therefore must reserve global
    // capacity before approval.
    total += pendingReceptionBytes(excludePendingId);
    return total;
  }

  // Active and recoverable-trash reception links both own bytes under INBOX_DIR.
  // Housekeeping needs the same ownership view as quota accounting so deleting a
  // physical file also releases the matching logical bytesReceived reservation.
  function receptionSharesIncludingTrash() {
    const out = [];
    for (const sh of (live.state.shares || [])) if (sh && (sh.type === 'inbox' || sh.type === 'collab')) out.push(sh);
    for (const rec of (Array.isArray(live.state.trash) ? live.state.trash : [])) {
      const sh = rec && rec.share;
      if (sh && (sh.type === 'inbox' || sh.type === 'collab')) out.push(sh);
    }
    return out;
  }
  function receptionShareForManagedPath(absPath, preferredShareId = null) {
    let target;
    try { target = path.resolve(String(absPath || '')); } catch (_) { return null; }
    const candidates = [];
    for (const sh of receptionSharesIncludingTrash()) {
      if (!sh.relDir) continue;
      let root;
      try { root = path.resolve(resolveWithin(INBOX_DIR, sh.relDir)); } catch (_) { continue; }
      if (target !== root && !target.startsWith(root + path.sep)) continue;
      candidates.push({ sh, root });
    }
    if (!candidates.length) return null;
    if (preferredShareId) {
      const exact = candidates.find((x) => String(x.sh.id) === String(preferredShareId));
      if (exact) return exact.sh;
    }
    // Prefer the most-specific root. Legacy links may share one relDir; in that case
    // release bytes from exactly ONE logical owner (never every matching link), choosing
    // the counter that can most plausibly account for the deleted file.
    candidates.sort((a, b) => b.root.length - a.root.length || Math.max(0, Number(b.sh.bytesReceived) || 0) - Math.max(0, Number(a.sh.bytesReceived) || 0));
    return candidates[0].sh;
  }
  function releaseReceptionManagedBytes(absPath, bytes, preferredShareId = null) {
    bytes = Math.max(0, Number(bytes) || 0);
    if (!bytes) return null;
    const sh = receptionShareForManagedPath(absPath, preferredShareId);
    if (!sh) return null;
    sh.bytesReceived = Math.max(0, (Number(sh.bytesReceived) || 0) - bytes);
    return sh;
  }
  function safeManagedInboxFilePath(absPath) {
    let resolved, rootReal, parentReal;
    try {
      resolved = path.resolve(String(absPath || ''));
      const inboxRoot = path.resolve(INBOX_DIR);
      if (resolved === inboxRoot || !resolved.startsWith(inboxRoot + path.sep)) return null;
      const rel = path.relative(inboxRoot, resolved).replace(/\\/g, '/');
      const first = rel.split('/')[0];
      if (first === '.dxparts' || first === '.dxpending' || !first) return null;
      rootReal = fs.realpathSync.native ? fs.realpathSync.native(INBOX_DIR) : fs.realpathSync(INBOX_DIR);
      parentReal = fs.realpathSync.native ? fs.realpathSync.native(path.dirname(resolved)) : fs.realpathSync(path.dirname(resolved));
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) return null;
      return resolved;
    } catch (_) { return null; }
  }
  function receptionCapExceeded(addBytes, excludePendingId = null) {
    const cap = receptionStorageCapBytes();
    if (!cap) return false;
    return currentReceptionBytes(excludePendingId) + Math.max(0, Number(addBytes) || 0) > cap;
  }

  function inboxRejectReason(s, name, sizeHint, opts = {}) {
    const ext = fileExt(name);
    const block = Array.isArray(s.blockExt) ? s.blockExt : [];
    const allow = Array.isArray(s.allowExt) ? s.allowExt : [];
    if (block.length && block.includes(ext)) return 'ext-blocked';
    if (allow.length && !allow.includes(ext)) return 'ext-not-allowed';
    const pending = pendingUsageForShare(s, opts.excludePendingId || null);
    const usedFiles = Math.max(0, Number(s.downloads) || 0) + pending.files;
    const usedBytes = Math.max(0, Number(s.bytesReceived) || 0) + pending.bytes;
    if (!opts.replacingExisting && s.maxFiles > 0 && usedFiles >= s.maxFiles) {
      addShareCenterNotification(s, 'reception-quota-reached', { reason:'files', count:usedFiles, limit:Number(s.maxFiles), dedupeKey:`reception-quota:${s.id}:files:${s.maxFiles}` });
      return 'max-files';
    }
    if (s.maxFileBytes > 0 && sizeHint > 0 && sizeHint > s.maxFileBytes) return 'file-too-large';
    if (s.maxTotalBytes > 0 && sizeHint > 0 && usedBytes + (opts.replacingExisting ? 0 : sizeHint) > s.maxTotalBytes) {
      if (usedBytes >= Number(s.maxTotalBytes)) maybeCenterReceptionQuota(s);
      return 'quota-full';
    }
    if (!s.webStorage && receptionCapExceeded(sizeHint, opts.excludePendingId || null)) return 'storage-cap'; // global local-disk cap
    return null;
  }

  // HTTP status for each reception rejection reason.
  function inboxRejectStatus(reason) {
    if (reason === 'ext-blocked' || reason === 'ext-not-allowed' || reason === 'content-blocked') return 415;
    if (reason === 'file-too-large' || reason === 'quota-full' || reason === 'storage-cap' || reason === 'sender-storage-cap') return 413;
    if (reason === 'moderation-full') return 507;
    if (reason === 'max-files' || reason === 'sender-file-limit' || reason === 'duplicate' || reason === 'moderation-busy') return 409;
    return 400;
  }

  // Per-link content-hash memory so a reception link can refuse a file
  // whose bytes already arrived. Bounded so a scraped link can't grow shares.json.
  const RECEPTION_HASH_MAX = 20000;
  function receptionHashEntry(s, sha) {
    return sha && s && s.receivedHashes && s.receivedHashes[sha] ? s.receivedHashes[sha] : null;
  }
  function receptionHashSeen(s, sha) {
    const entry = receptionHashEntry(s, sha);
    if (!entry) return false;
    // Path-aware entries are only duplicates while the referenced file still exists.
    // Self-destruct/retention/manual deletion must not permanently poison the hash set.
    if (entry && typeof entry === 'object' && entry.path) return !!receptionDuplicateStoredPath(s, sha);
    return true; // legacy numeric entries have no path to validate
  }
  function stripWindowsPathNamespace(value) {
    let p = String(value || '');
    if (process.platform !== 'win32') return p;
    if (/^\\\\\?\\UNC\\/i.test(p)) return '\\\\' + p.slice(8);
    if (/^\\\\\?\\/.test(p)) return p.slice(4);
    return p;
  }
  function receptionComparableRealPath(value) {
    const lexical = path.resolve(stripWindowsPathNamespace(value));
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(lexical) : fs.realpathSync(lexical);
      return path.resolve(stripWindowsPathNamespace(real));
    } catch (_) {
      return lexical;
    }
  }
  function receptionRelativeStoredPath(dest) {
    if (!dest) return '';
    try {
      // reserveUniqueUploadPath() intentionally writes through the REAL reception
      // directory after the anti-symlink check. On Windows this real path can also
      // carry the extended "\\\\?\\" prefix, and GitHub-hosted runner temp paths may
      // traverse a junction. Comparing that physical destination with the lexical
      // INBOX_DIR therefore makes path.relative() report an unrelated/absolute path.
      // Canonicalize BOTH sides to their real, non-namespaced locations first, then
      // persist only a portable path relative to INBOX_DIR.
      const inboxRoot = receptionComparableRealPath(INBOX_DIR);
      const resolvedDest = receptionComparableRealPath(dest);
      const rawRel = path.relative(inboxRoot, resolvedDest);
      if (!rawRel || rawRel === '..' || rawRel.startsWith('..' + path.sep) || path.isAbsolute(rawRel)) return '';
      return rawRel.split(path.sep).join('/').slice(0, 800);
    } catch (_) { return ''; }
  }
  function receptionMetadataPath(absPath) {
    if (!absPath) return '';
    const rel = receptionRelativeStoredPath(absPath);
    if (rel) {
      try { return resolveWithin(INBOX_DIR, rel); } catch (_) {}
    }
    try { return path.resolve(stripWindowsPathNamespace(absPath)); }
    catch (_) { return String(absPath || ''); }
  }
  function deleteFileExpiryForPath(absPath) {
    const map = live.state.meta && live.state.meta.fileExpiry && typeof live.state.meta.fileExpiry === 'object' ? live.state.meta.fileExpiry : null;
    if (!map || !absPath) return;
    const raw = String(absPath);
    delete map[raw];
    const normalized = receptionMetadataPath(raw);
    if (normalized && normalized !== raw) delete map[normalized];
  }
  function rememberReceptionHash(s, sha, dest = '') {
    if (!sha) return;
    if (!s.receivedHashes || typeof s.receivedHashes !== 'object') s.receivedHashes = {};
    if (s.receivedHashes[sha] === undefined && Object.keys(s.receivedHashes).length >= RECEPTION_HASH_MAX) return;
    const rel = receptionRelativeStoredPath(dest);
    // Old installations stored the number 1. Preserve compatibility while enriching
    // new entries with the stored relative path used by duplicate preflight/replace.
    s.receivedHashes[sha] = rel ? { path: rel, at: Date.now() } : (s.receivedHashes[sha] || 1);
  }
  function receptionDuplicateStoredPath(s, sha) {
    const entry = receptionHashEntry(s, sha);
    const rel = entry && typeof entry === 'object' ? String(entry.path || '') : '';
    if (!rel) return null;
    try {
      const target = resolveWithin(INBOX_DIR, rel);
      const root = resolveWithin(INBOX_DIR, s.relDir || '');
      const rr = path.relative(root, target);
      if (rr === '..' || rr.startsWith('..' + path.sep) || path.isAbsolute(rr)) return null;
      const st = fs.statSync(target);
      if (!st.isFile()) throw Object.assign(new Error('not-file'), { code:'ENOENT' });
      return target;
    } catch (e) {
      // Newer entries know the physical path. Prune it lazily when the file was
      // removed by self-destruct/retention/admin cleanup so future uploads are not
      // reported as duplicates forever.
      if (s && s.receivedHashes && typeof s.receivedHashes === 'object' && s.receivedHashes[sha] && typeof s.receivedHashes[sha] === 'object') {
        delete s.receivedHashes[sha];
        scheduleFlush();
      }
      return null;
    }
  }
  // Returns 'duplicate' (and remembers the hash otherwise) for a stored reception
  // file, or null when the link does not de-duplicate. Runs inside the share lock.
  async function receptionDuplicateReason(s, storedPath, clientSha) {
    if (!s || !s.rejectDuplicates) return null;
    let sha = /^[a-f0-9]{64}$/.test(String(clientSha || '')) ? clientSha : '';
    if (!sha) { try { sha = await hashFileSha256(storedPath); } catch (_) { sha = ''; } }
    if (!sha) return null; // can't hash → don't block
    if (receptionHashSeen(s, sha)) return 'duplicate';
    rememberReceptionHash(s, sha, storedPath);
    return null;
  }

  // Sanitizes a client-supplied relative path (folder upload). Returns
  // { dirSegs, filename } with each segment cleaned and traversal removed, or
  // null if unusable. Depth is capped to keep trees sane.
  function safeUploadRelPath(rel) {
    const parts = String(rel || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((p) => p.trim())
      .filter((p) => p && p !== '.' && p !== '..');
    if (!parts.length) return null;
    const filename = safeUploadName(parts.pop());
    const dirSegs = parts.map((p) => safeUploadName(p)).filter((p) => p && p !== 'file').slice(0, 20);
    return { dirSegs, filename };
  }

  // Folder creation is stricter than file-name cleanup: reject invalid or
  // platform-reserved names instead of silently rewriting them, so the visitor
  // always knows the exact folder that was created.
  function safeUploadFolderName(name) {
    const raw = String(name == null ? '' : name).trim();
    if (!raw || raw.length > 120 || raw === '.' || raw === '..') return null;
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(raw) || /[. ]$/.test(raw)) return null;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(raw)) return null;
    return raw;
  }

  function safeUploadParentSegments(rel) {
    const raw = String(rel == null ? '' : rel).replace(/\\/g, '/');
    if (!raw) return [];
    if (raw.length > 2000) return null;
    const parts = raw.split('/');
    if (parts.length > 20 || parts.some((part) => !safeUploadFolderName(part))) return null;
    return parts;
  }

  // When a reception link groups by sender, received files land in a
  // <sender>/<YYYY-MM-DD>/ subfolder. Returns those path segments (or [] when off).
  // The sender name comes from the visitor (?sender=), sanitized to one safe
  // segment; empty falls back to "anonymous".
  function senderSubdirSegs(s, req) {
    if (!s || !s.groupBySender) return [];
    let sender = cleanSenderName(req) || 'anonymous';
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [sender, date];
  }

  // Prefix the stored filename with the sanitized sender name (keeping
  // the original extension so download-filters still match). "Alice - report.pdf".
  function senderTaggedName(senderName, filename) {
    const tag = String(senderName || '').replace(/[\/\\\r\n\t<>:"|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return tag ? (tag + ' - ' + filename) : filename;
  }

  // Per-sender upload quota. Keyed by the declared name when present,
  // else the masked IP so anonymous uploads are still bounded. Soft (a visitor can
  // retype another name), like every self-declared-sender feature.
  const SENDER_STATS_MAX = 5000;
  function uploadSenderKey(s, req, senderName) {
    const n = String(senderName || '').trim().toLowerCase().slice(0, 60);
    return n ? ('n:' + n) : ('ip:' + maskIp(clientIp(req)));
  }
  function perSenderRejectReason(s, req, senderName, sizeHint, opts = {}) {
    const fCap = Math.max(0, Number(s && s.maxFilesPerSender) || 0);
    const bCap = Math.max(0, Number(s && s.maxBytesPerSender) || 0);
    if (!fCap && !bCap) return null;
    const key = opts.senderKey || uploadSenderKey(s, req, senderName);
    const st = (s.senderStats && s.senderStats[key]) || { files: 0, bytes: 0 };
    const pending = pendingUsageForSender(s, key, opts.excludePendingId || null);
    const usedFiles = Math.max(0, Number(st.files) || 0) + pending.files;
    const usedBytes = Math.max(0, Number(st.bytes) || 0) + pending.bytes;
    if (!opts.replacingExisting && fCap && usedFiles >= fCap) return 'sender-file-limit';
    if (bCap && sizeHint > 0 && usedBytes + (opts.replacingExisting ? 0 : sizeHint) > bCap) return 'sender-storage-cap';
    return null;
  }
  function bumpSenderStatByKey(s, key, size) {
    const fCap = Math.max(0, Number(s && s.maxFilesPerSender) || 0);
    const bCap = Math.max(0, Number(s && s.maxBytesPerSender) || 0);
    if (!fCap && !bCap) return; // only track when a per-sender cap is configured
    if (!key) return;
    if (!s.senderStats || typeof s.senderStats !== 'object') s.senderStats = {};
    if (s.senderStats[key] === undefined && Object.keys(s.senderStats).length >= SENDER_STATS_MAX) return; // bounded
    const st = s.senderStats[key] || { files: 0, bytes: 0 };
    st.files = (st.files || 0) + 1;
    st.bytes = (st.bytes || 0) + (Number(size) || 0);
    s.senderStats[key] = st;
  }
  function bumpSenderStat(s, req, senderName, size) {
    bumpSenderStatByKey(s, uploadSenderKey(s, req, senderName), size);
  }

  // Atomically reserves a destination name with an empty placeholder. A separate
  // access-then-write check is racy: simultaneous uploads with the same name can
  // both select it and truncate each other.
  async function reserveUniqueUploadPath(dir, filename) {
    const realDir = await assertRealWithin(INBOX_DIR, dir);
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let candidate = path.join(realDir, filename);
    let i = 1;
    while (true) {
      try {
        const fd = await openFd(candidate, 'wx', 0o600);
        try { await closeFd(fd); }
        catch (closeError) {
          // A reserved placeholder whose descriptor could not be closed must not
          // be handed to the upload path as if reservation completed cleanly.
          try { await fs.promises.unlink(candidate); } catch (_) {}
          throw closeError;
        }
        return candidate;
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
      candidate = i > 9999
        ? path.join(realDir, `${base}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`)
        : path.join(realDir, `${base} (${i})${ext}`);
      i++;
    }
  }

  // Serializes the final quota check and counter update for one reception link.
  // Node can process several completed uploads concurrently; without this small
  // critical section they can all observe the same remaining quota and exceed it.
  const shareUploadLocks = new Map();
  async function withShareUploadLock(shareId, fn) {
    const previous = shareUploadLocks.get(shareId) || Promise.resolve();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const current = previous.catch(() => {}).then(() => hold);
    shareUploadLocks.set(shareId, current);
    await previous.catch(() => {});
    try { return await fn(); }
    finally {
      release();
      if (shareUploadLocks.get(shareId) === current) shareUploadLocks.delete(shareId);
    }
  }

  // --- Resumable uploads: one .part file per upload, keyed by a client-supplied id ---
  // Internal partials belong in DATA_DIR, not in the user-facing reception folder.
  // Older releases placed them in INBOX_DIR/.dxparts, which polluted Documents on
  // the Windows portable build and could accidentally be selected for sharing.
  const PARTS_DIR = path.join(DATA_DIR, 'staging', 'upload-parts');
  const LEGACY_PARTS_DIR = path.join(INBOX_DIR, '.dxparts');
  function migrateLegacyUploadParts() {
    if (path.resolve(PARTS_DIR) === path.resolve(LEGACY_PARTS_DIR)) return;
    let legacyStat;
    try { legacyStat = fs.lstatSync(LEGACY_PARTS_DIR); }
    catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
    if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) return;
    let names = [];
    try { names = fs.readdirSync(LEGACY_PARTS_DIR); } catch (_) { return; }
    const movable = names.filter((name) => /^[a-f0-9]{64}$/i.test(name));
    if (movable.length) {
      try { fs.mkdirSync(PARTS_DIR, { recursive:true, mode:0o700 }); } catch (_) { return; }
    }
    for (const name of movable) {
      const source = path.join(LEGACY_PARTS_DIR, name);
      const target = path.join(PARTS_DIR, name);
      try {
        const st = fs.lstatSync(source);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        if (fs.existsSync(target)) {
          try { if (fs.statSync(target).size === st.size) fs.unlinkSync(source); } catch (_) {}
          continue;
        }
        try { fs.renameSync(source, target); }
        catch (error) {
          if (!error || error.code !== 'EXDEV') throw error;
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          fs.unlinkSync(source);
        }
      } catch (_) {}
    }
    // Remove the legacy infrastructure folder only when nothing (including an
    // unknown/user file) remains in it.
    try { if (fs.readdirSync(LEGACY_PARTS_DIR).length === 0) fs.rmdirSync(LEGACY_PARTS_DIR); } catch (_) {}
  }
  try { migrateLegacyUploadParts(); } catch (error) { console.warn('[upload] legacy .dxparts migration failed:', error.message); }
  // Moderation queue: files uploaded to a moderated link wait here
  // until an admin approves (moved to the target folder) or rejects (deleted).
  const PENDING_DIR = path.join(INBOX_DIR, '.dxpending');

  const PENDING_MODERATION_MAX = 2000;
  const pendingModerationClaims = new Set();
  let lastPendingOrphanCleanupAt = 0;
  function claimPendingModeration(id) {
    id = String(id || '');
    if (!id || pendingModerationClaims.has(id)) return false;
    pendingModerationClaims.add(id); return true;
  }
  function releasePendingModeration(id) { if (id) pendingModerationClaims.delete(String(id)); }
  function deletePendingFileStrict(id) {
    const file = path.join(PENDING_DIR, String(id || ''));
    try { fs.unlinkSync(file); return true; }
    catch (e) { if (e && e.code === 'ENOENT') return true; throw e; }
  }

  function stagePendingFileRemoval(id, purpose = 'remove') {
    const file = path.join(PENDING_DIR, String(id || ''));
    const staged = path.join(PENDING_DIR, `.staged-${String(purpose || 'remove').replace(/[^a-z0-9_-]/gi,'').slice(0,24)}-${String(id || '').replace(/[^a-z0-9]/gi,'').slice(0,24)}-${crypto.randomBytes(4).toString('hex')}`);
    let moved = false;
    try {
      fs.renameSync(file, staged);
      moved = true;
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) throw e;
    }
    return {
      rollback() {
        if (!moved) return true;
        try {
          if (fs.existsSync(staged) && !fs.existsSync(file)) fs.renameSync(staged, file);
          moved = false; return true;
        } catch (e) { console.error('[moderation] staged-file rollback failed:', e.message); return false; }
      },
      finalize() {
        if (!moved) return true;
        try { fs.unlinkSync(staged); moved = false; return true; }
        catch (e) { if (e && e.code === 'ENOENT') { moved = false; return true; } console.error('[moderation] staged-file cleanup failed:', e.message); return false; }
      },
    };
  }

  // Records a pending (awaiting-moderation) upload. Quotas are re-checked with the
  // REAL file size inside the per-share lock, because several completed uploads may
  // arrive at once. Pending bytes reserve capacity immediately even though approved
  // counters are not incremented until the moderator accepts the file.
  async function stashPending(s, srcPart, rel, req, opts = {}) {
    try { await fs.promises.mkdir(PENDING_DIR, { recursive: true }); } catch (_) {}
    return withShareUploadLock(s.id, async () => {
      if (!live.state.meta || typeof live.state.meta !== 'object') live.state.meta = {};
      if (!Array.isArray(live.state.meta.pending)) live.state.meta.pending = [];
      if (live.state.meta.pending.length >= PENDING_MODERATION_MAX) return { error: 'moderation-full' };
      let size = 0;
      try { size = (await fs.promises.stat(srcPart)).size; } catch (_) { return { error: 'write-error' }; }
      const senderName = String(opts.senderName || '').slice(0, 60);
      const senderKey = opts.senderKey || uploadSenderKey(s, req, senderName);
      const quotaReason = inboxRejectReason(s, rel || 'file', size);
      if (quotaReason) return { error: quotaReason };
      const senderReason = perSenderRejectReason(s, req, senderName, size, { senderKey });
      if (senderReason) return { error: senderReason };

      // Preserve duplicate rejection across moderation without marking a rejected
      // file as permanently seen. We remember the hash only after approval.
      let sha = validSha256Hex(opts.sha256);
      if (s.rejectDuplicates && !sha) { try { sha = await hashFileSha256(srcPart); } catch (_) { sha = ''; } }
      if (s.rejectDuplicates && sha) {
        if (receptionHashSeen(s, sha) || live.state.meta.pending.some((row) => row && row.shareId === s.id && row.sha256 === sha)) return { error: 'duplicate' };
      }

      const id = crypto.randomBytes(9).toString('hex');
      let pendingReal;
      try { pendingReal = await assertRealWithin(INBOX_DIR, PENDING_DIR); }
      catch (_) { return { error: 'write-error' }; }
      const dest = path.join(pendingReal, id);
      try { await fs.promises.rename(srcPart, dest); }
      catch (_) {
        try { await fs.promises.copyFile(srcPart, dest); await fs.promises.unlink(srcPart); }
        catch (e) { return { error: 'write-error' }; }
      }
      const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
      const row = {
        id, shareId: s.id, shareName: s.name, name: rel || 'file', size,
        ip: pubIp(ip), at: Date.now(), sender: senderName || null, senderKey,
        destRel: String(opts.destRel || rel || 'file').slice(0, 2400),
        expireSec: Math.max(0, Number(opts.expireSec) || 0),
        sha256: sha || null,
      };
      live.state.meta.pending.unshift(row);
      // Do not acknowledge a moderated upload until its queue metadata is durable.
      // Otherwise a crash between the HTTP success and the deferred flush leaves an
      // orphan .dxpending file that the cleanup job eventually deletes as "unknown".
      if (!persistNow()) {
        const idx = live.state.meta.pending.findIndex((item) => item && item.id === id);
        if (idx >= 0) live.state.meta.pending.splice(idx, 1);
        try { await fs.promises.unlink(dest); } catch (_) {}
        return { error: 'write-error' };
      }
      maybeCenterReceptionQuota(s);
      evaluateCustomNotificationRulesForShare(s);
      return { ok: true, row };
    });
  }

  // Legacy versions could truncate pending metadata at 2000 rows without deleting
  // the corresponding .dxpending file. Remove only old, random-id orphan files and
  // never touch current tmp-* uploads or a very recent file that may still be in the
  // short rename→metadata insertion window.
  async function cleanupOrphanPendingFiles(now = Date.now()) {
    let entries;
    try { entries = await fs.promises.readdir(PENDING_DIR, { withFileTypes: true }); } catch (_) { return 0; }
    const known = new Set(pendingModerationRows().map((row) => row && String(row.id || '')).filter(Boolean));
    let removed = 0;
    for (const ent of entries) {
      if (!ent || !ent.isFile() || !/^[a-f0-9]{18}$/.test(ent.name) || known.has(ent.name) || pendingModerationClaims.has(ent.name)) continue;
      const file = path.join(PENDING_DIR, ent.name);
      try {
        const st = await fs.promises.stat(file);
        if (now - st.mtimeMs < 10 * 60 * 1000) continue;
        await fs.promises.unlink(file); removed += 1;
      } catch (_) {}
    }
    if (removed) logAudit('pending-orphans-cleaned', { username: 'system', detail: `${removed} orphan pending file(s)` });
    return removed;
  }

  function pendingSenderKey(row) {
    if (row && row.senderKey) return String(row.senderKey);
    const sender = String(row && row.sender || '').trim().toLowerCase().slice(0, 60);
    return sender ? ('n:' + sender) : null;
  }

  function applyReceptionAccountingState(s, opts = {}) {
    const size = Math.max(0, Number(opts.size) || 0);
    const sha = validSha256Hex(opts.sha);
    const senderKey = opts.senderKey ? String(opts.senderKey) : null;
    const dest = opts.dest ? String(opts.dest) : '';
    const expireSec = Math.max(0, Number(opts.expireSec) || 0);
    if (sha) rememberReceptionHash(s, sha, dest);
    s.bytesReceived = Math.max(0, Number(s.bytesReceived) || 0) + size;
    const beforeDownloads = Math.max(0, Number(s.downloads) || 0);
    s.downloads = beforeDownloads + 1;
    const maxDownloads = Math.max(0, Number(s.maxDownloads) || 0);
    if (maxDownloads > 0 && beforeDownloads < maxDownloads && s.downloads >= maxDownloads) s.downloadLimitReachedAt = Date.now();
    const firstInboxDeposit = beforeDownloads === 0 && s.type === 'inbox';
    if (firstInboxDeposit && !s.centerFirstDepositAt) s.centerFirstDepositAt = Date.now();
    if (senderKey) bumpSenderStatByKey(s, senderKey, size);
    if (expireSec > 0 && dest) {
      live.recordFileExpiry(dest, expireSec, s, path.basename(dest));
    }
    return { beforeDownloads, firstInboxDeposit, size, sha, senderKey, dest, expireSec };
  }
  function finalizeReceptionAccountingEffects(s, accounting) {
    if (!s || !accounting) return;
    if (accounting.firstInboxDeposit) addShareCenterNotification(s, 'inbox-first-deposit', { count:1, dedupeKey:`inbox-first-deposit:${s.id}` });
    maybeCenterReceptionQuota(s);
    evaluateCustomNotificationRulesForShare(s);
    scheduleFlush();
  }
  function rollbackReceptionAccountingState(s, beforeShare, dest) {
    if (s && beforeShare) restorePlainObject(s, beforeShare);
    if (dest) deleteFileExpiryForPath(dest);
  }
  async function rollbackAcceptedUploadFile(target, restorePath = null) {
    if (!target) return true;
    try {
      if (!fs.existsSync(target)) return true;
      if (restorePath) {
        try { await fs.promises.rename(target, restorePath); return true; }
        catch (_) {
          try { await fs.promises.copyFile(target, restorePath); await fs.promises.unlink(target); return true; }
          catch (e) { console.error('[upload] rollback to partial failed:', e.message); return false; }
        }
      }
      await fs.promises.unlink(target); return true;
    } catch (e) { console.error('[upload] accepted-file rollback failed:', e.message); return false; }
  }
  async function approvePendingModeration(s, row) {
    if (!s || !row) return { error: 'not-found' };
    const src = path.join(PENDING_DIR, String(row.id || ''));
    const parsed = safeUploadRelPath(row.destRel || row.name || 'file');
    if (!parsed) return { error: 'write-error' };
    return withShareUploadLock(s.id, async () => {
      let size = Math.max(0, Number(row.size) || 0);
      try { size = (await fs.promises.stat(src)).size; } catch (_) { return { error: 'write-error' }; }
      const quotaReason = inboxRejectReason(s, row.name || parsed.filename, size, { excludePendingId: row.id });
      if (quotaReason) return { error: quotaReason };
      const senderKey = pendingSenderKey(row);
      if (senderKey) {
        const senderReason = perSenderRejectReason(s, null, row.sender || '', size, { senderKey, excludePendingId: row.id });
        if (senderReason) return { error: senderReason };
      }

      let sha = validSha256Hex(row.sha256);
      if (s.rejectDuplicates && !sha) { try { sha = await hashFileSha256(src); } catch (_) { sha = ''; } }
      if (s.rejectDuplicates && sha && receptionHashSeen(s, sha)) return { error: 'duplicate' };

      let rootDir;
      try { rootDir = s.type === 'collab' ? collabRoot(s) : resolveWithin(INBOX_DIR, s.relDir || ''); }
      catch (_) { return { error: 'inbox-dir' }; }
      let dir;
      try { dir = resolveWithin(rootDir, parsed.dirSegs.join('/')); await fs.promises.mkdir(dir, { recursive: true }); }
      catch (_) { return { error: 'inbox-dir' }; }
      let dest;
      try { dest = await reserveUniqueUploadPath(dir, parsed.filename); }
      catch (_) { return { error: 'write-error' }; }
      try { await fs.promises.rename(src, dest); }
      catch (_) {
        try { await fs.promises.copyFile(src, dest); await fs.promises.unlink(src); }
        catch (e) { try { await fs.promises.unlink(dest); } catch (_) {} return { error: 'write-error' }; }
      }

      // Mutate only durable accounting live.state here. User-visible notifications/SSE and
      // search/dedupe side effects are deliberately deferred until the caller has
      // persisted this live.state successfully, so a failed shares.json write cannot
      // announce an approval that will disappear after restart.
      const accounting = applyReceptionAccountingState(s, { size, sha, senderKey, dest, expireSec:Math.max(0, Number(row.expireSec) || 0) });
      const pendingList = pendingModerationRows();
      const pendingIndex = pendingList.findIndex((item) => item && item.id === row.id);
      if (pendingIndex >= 0) pendingList.splice(pendingIndex, 1);
      return { ok: true, dest, size, sha, sender: row.sender || null, senderKey, accounting };
    });
  }

  function finalizePendingModerationApproval(s, row, outcome) {
    if (!s || !row || !outcome || !outcome.ok) return;
    finalizeReceptionAccountingEffects(s, outcome.accounting);
    if (outcome.sha) verifyAndRememberDedupe(outcome.dest);
    try { scheduleSearchReindex(); } catch (_) {}
    if (s.type === 'inbox') {
      try { emitInboxEvent(s, { type:'received', name:path.basename(outcome.dest), dest:s.name || '', at:Date.now(), sender:row.sender || undefined }); } catch (_) {}
    }
  }

  // Scans a file via clamd's INSTREAM protocol. Resolves
  // { infected, virus } | { infected:false } | { error }. Fails open (returns
  // { error }) so a scanner outage never silently drops uploads — the caller
  // decides what to do on error (here: let the file through, but log it).
  function scanFile(absPath) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (done) return; done = true; try { socket.destroy(); } catch (_) {} resolve(r); };
      const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
      let reply = '';
      const handle = () => {
        if (/FOUND/.test(reply)) { const m = /:\s*(.+?)\s+FOUND/.exec(reply); finish({ infected: true, virus: m ? m[1] : 'malware' }); }
        else if (/\bOK\b/.test(reply)) finish({ infected: false });
        else if (/ERROR/.test(reply)) finish({ error: reply.trim() });
      };
      socket.setTimeout(180000, () => finish({ error: 'timeout' }));
      socket.on('error', (e) => finish({ error: e.message }));
      socket.on('data', (d) => { reply += d.toString('utf8'); handle(); });
      socket.on('end', () => handle());
      socket.on('close', () => finish({ error: reply.trim() || 'no-reply' }));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const rs = fs.createReadStream(absPath, { highWaterMark: 64 * 1024 });
        rs.on('data', (chunk) => {
          const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length, 0);
          socket.write(len); socket.write(chunk);
        });
        rs.on('end', () => { const z = Buffer.alloc(4); z.writeUInt32BE(0, 0); socket.write(z); });
        rs.on('error', () => finish({ error: 'read-error' }));
      });
    });
  }
  // Moves an infected upload to the quarantine folder and alerts the admin.
  async function quarantineFile(src, name, s, virus, req) {
    try { await fs.promises.mkdir(QUARANTINE_DIR, { recursive: true }); } catch (_) {}
    const dest = path.join(QUARANTINE_DIR, crypto.randomBytes(8).toString('hex') + '-' + safeUploadName(name));
    try { await fs.promises.rename(src, dest); } catch (_) { try { await fs.promises.unlink(src); } catch (e) {} }
    logAudit('upload-infected', { username: 'system', ip: clientIp(req), detail: (s.name || s.id) + ': ' + name + ' [' + virus + ']' });
    dispatch('security', `${APP_NAME} — Infected upload blocked`,
      `🦠 ${APP_NAME} — Infected upload blocked on "${s.name || ''}": ${name} [${virus}]`,
      { share: s.name || null, name, virus, shareId: s.id || null },
      { pushAccountIds: [...new Set([notificationAccountIdForShare(s), ...notificationAdminAccountIds()].filter(Boolean))] });
  }
  // Scans a finished upload part when antivirus is enabled. Returns true if it is
  // safe to deliver; false if it was infected (already quarantined + alerted).
  async function scanGate(part, name, s, req) {
    if (!clamavEnabled()) return true;
    const r = await scanFile(part);
    if (r.infected) { emitLiveActivity('antivirus', { shareId:s && s.id, name, status:'infected', detail:r.virus, ip:pubIp(clientIp(req)) }); await quarantineFile(part, name, s, r.virus, req); return false; }
    if (r.error) { console.error('[clamav] scan error (delivering unscanned):', r.error); emitLiveActivity('antivirus', { shareId:s && s.id, name, status:'error', detail:r.error, ip:pubIp(clientIp(req)) }); }
    else emitLiveActivity('antivirus', { shareId:s && s.id, name, status:'clean', ip:pubIp(clientIp(req)) });
    return true;
  }
  function safeUploadId(id) {
    return /^[A-Za-z0-9_-]{6,64}$/.test(String(id || '')) ? String(id) : null;
  }
  function safeUploadByteCount(value) { const raw=String(value==null?'':value),n=/^\d+$/.test(raw)?Number(raw):NaN; return Number.isSafeInteger(n)&&n>=0?n:null; }
  function scopedUploadId(s, id) {
    return crypto.createHash('sha256').update(String(s.id)).update('\0').update(id).digest('hex');
  }
  function partPath(s, id) {
    return path.join(PARTS_DIR, scopedUploadId(s, id));
  }
  // Periodically drop abandoned partials (an interrupted upload never resumed).
  setInterval(() => {
    fs.readdir(PARTS_DIR, (err, names) => {
      if (err) return;
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const n of names) {
        const p = path.join(PARTS_DIR, n);
        fs.stat(p, (e, st) => { if (!e && st.mtimeMs < cutoff) fs.unlink(p, () => {}); });
      }
    });
  }, 3600 * 1000).unref();

  // Chunked uploads: all chunk requests of one upload share a SINGLE
  // transfer (keyed by upload id) so the admin live view / history show one
  // advancing row instead of one per chunk. `stoppedUploads` blocks further chunks
  // after an admin stop (so the client can't silently restart the upload).
  const uploadTransfers = new Map(); // upload id -> transfer (spans chunk requests)
  const stoppedUploads = new Map();  // upload id -> expiry ms
  const uploadsInFlight = new Set();  // upload ids whose chunk is currently being written
  // A committed upload must remain idempotent when its final HTTP response is lost.
  // Without a short-lived receipt, upload-status sees no .part (it was renamed) and
  // a background/foreground retry stores a second copy from offset zero.
  const completedUploadReceipts = new Map(); // scoped upload id -> { at, size, path, response }
  const COMPLETED_UPLOAD_RECEIPT_TTL_MS = 24 * 3600 * 1000;
  const COMPLETED_UPLOAD_RECEIPT_MAX = 5000;
  let activePublicUploads = 0;

  function completedUploadReceipt(uploadId) {
    if (!uploadId) return null;
    const receipt = completedUploadReceipts.get(uploadId);
    if (!receipt) return null;
    if (Date.now() - receipt.at > COMPLETED_UPLOAD_RECEIPT_TTL_MS) {
      completedUploadReceipts.delete(uploadId);
      return null;
    }
    return receipt;
  }
  function rememberCompletedUpload(uploadId, size, relPath, response) {
    if (!uploadId) return;
    completedUploadReceipts.set(uploadId, {
      at: Date.now(),
      size: Math.max(0, Number(size) || 0),
      path: String(relPath || ''),
      response: response && typeof response === 'object' ? { ...response } : { ok:true },
    });
    if (completedUploadReceipts.size <= COMPLETED_UPLOAD_RECEIPT_MAX) return;
    const oldest = [...completedUploadReceipts.entries()].sort((a, b) => a[1].at - b[1].at)
      .slice(0, completedUploadReceipts.size - COMPLETED_UPLOAD_RECEIPT_MAX);
    for (const [key] of oldest) completedUploadReceipts.delete(key);
  }

  function beginPublicUpload(req, res) {
    if (activePublicUploads >= MAX_CONCURRENT_UPLOADS) {
      req.resume();
      res.setHeader('Retry-After', '5');
      res.status(429).json({ error: 'too-many-uploads' });
      return false;
    }
    activePublicUploads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activePublicUploads = Math.max(0, activePublicUploads - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
      const err = new Error('upload-timeout');
      err.code = 'UPLOAD_TIMEOUT';
      req.destroy(err);
    });
    return true;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of uploadTransfers) {
      if (now - (t.lastActivity || t.startedAt) > 5 * 60 * 1000) { // upload abandoned mid-way
        uploadTransfers.delete(id);
        uploadsInFlight.delete(id);
        try { endTransfer(t, false, 'timeout'); } catch (_) {}
      }
    }
    for (const [id, exp] of stoppedUploads) if (exp < now) stoppedUploads.delete(id);
  }, 60 * 1000).unref();


  const dedupeHashCache = new Map(); // "size:sha256" -> [{ path, size, mtimeMs }]
  const dedupeChallenges = new Map(); // one-use proof-of-possession challenges
  const DEDUPE_SCAN_FILE_LIMIT = 50000;
  const DEDUPE_MATCH_LIMIT = 256;
  const DEDUPE_CHALLENGE_TTL_MS = 60 * 1000;
  function validSha256Hex(v) { const h = String(v || '').trim().toLowerCase(); return /^[a-f0-9]{64}$/.test(h) ? h : ''; }
  function dedupeKey(size, sha) { return String(size) + ':' + sha; }
  function rememberDedupeFile(filePath, size, sha, mtimeMs) {
    sha = validSha256Hex(sha); size = Number(size) || 0;
    if (!sha || size < 0 || !filePath) return;
    const key = dedupeKey(size, sha), rows = dedupeHashCache.get(key) || [];
    const clean = rows.filter((r) => r && r.path !== filePath).slice(-15);
    clean.push({ path: filePath, size, mtimeMs: Number(mtimeMs) || 0 });
    dedupeHashCache.set(key, clean);
  }
  async function cachedDedupeCandidate(size, sha) {
    const rows = (dedupeHashCache.get(dedupeKey(size, sha)) || []).slice().reverse();
    for (const row of rows) {
      try {
        const st = await fs.promises.stat(row.path);
        if (st.isFile() && st.size === size && (!row.mtimeMs || Math.abs(st.mtimeMs - row.mtimeMs) < 2)) return row.path;
      } catch (_) {}
    }
    return null;
  }
  async function scanDedupeCandidate(size, sha) {
    let visited = 0, matched = 0;
    const roots = [INBOX_DIR, FULL_IMAGES_DIR];
    for (const root of roots) {
      const stack = [root];
      while (stack.length && visited < DEDUPE_SCAN_FILE_LIMIT && matched < DEDUPE_MATCH_LIMIT) {
        const dir = stack.pop(); let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const ent of entries) {
          if (visited >= DEDUPE_SCAN_FILE_LIMIT || matched >= DEDUPE_MATCH_LIMIT) break;
          if (!ent || ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (ent.name === '.dxparts' || ent.name === '.dxpending') continue;
            stack.push(path.join(dir, ent.name));
            continue;
          }
          if (!ent.isFile()) continue;
          visited++;
          const abs = path.join(dir, ent.name); let st;
          try { st = await fs.promises.stat(abs); } catch (_) { continue; }
          if (st.size !== size) continue;
          matched++;
          let actual = '';
          try { actual = await hashFileSha256(abs); } catch (_) { continue; }
          rememberDedupeFile(abs, st.size, actual, st.mtimeMs);
          if (actual === sha) return abs;
        }
      }
    }
    return null;
  }
  async function findDedupeCandidate(size, sha) {
    return (await cachedDedupeCandidate(size, sha)) || scanDedupeCandidate(size, sha);
  }
  function verifyAndRememberDedupe(filePath) {
    fs.promises.stat(filePath).then((st) => {
      if (!st.isFile()) return null;
      return hashFileSha256(filePath).then((sha) => rememberDedupeFile(filePath, st.size, sha, st.mtimeMs));
    }).catch(() => {});
  }
  function cleanupDedupeChallenges() {
    const now = Date.now();
    for (const [id, row] of dedupeChallenges) if (!row || row.exp <= now) dedupeChallenges.delete(id);
    while (dedupeChallenges.size > 512) dedupeChallenges.delete(dedupeChallenges.keys().next().value);
  }
  function makeDedupeRanges(size, nonce) {
    if (size <= 0) return [];
    if (size <= 192) return [{ offset: 0, length: size }];
    const length = 64, max = size - length;
    const ranges = [];
    for (let i = 0; i < 3; i++) {
      const digest = crypto.createHash('sha256').update(nonce + ':' + i).digest('hex').slice(0, 16);
      const offset = Number(BigInt('0x' + digest) % BigInt(max + 1));
      ranges.push({ offset, length });
    }
    return ranges;
  }
  async function readDedupeRange(filePath, offset, length) {
    const fd = await openFd(filePath, 'r');
    try {
      const buf = Buffer.alloc(length), got = await readFd(fd, buf, 0, length, offset);
      return got.bytesRead === length ? buf : buf.subarray(0, got.bytesRead);
    } finally { await closeFd(fd).catch(() => {}); }
  }
  async function verifyDedupeProof(challenge, proof) {
    if (!challenge || !Array.isArray(proof) || proof.length !== challenge.ranges.length) return false;
    for (let i = 0; i < challenge.ranges.length; i++) {
      const r = challenge.ranges[i]; let supplied;
      try { supplied = Buffer.from(String(proof[i] || ''), 'base64'); } catch (_) { return false; }
      if (supplied.length !== r.length) return false;
      const actual = await readDedupeRange(challenge.source, r.offset, r.length);
      if (actual.length !== supplied.length || !crypto.timingSafeEqual(actual, supplied)) return false;
    }
    return true;
  }

  function maybeCleanupOrphanPendingFiles(now = Date.now()) {
    if (now - lastPendingOrphanCleanupAt < 60 * 60 * 1000) return false;
    lastPendingOrphanCleanupAt = now;
    cleanupOrphanPendingFiles(now).catch((e) => console.error('[maintenance] pending orphan cleanup:', e.message));
    return true;
  }

  function hasActiveUploads() {
    return activePublicUploads > 0 || uploadTransfers.size > 0 || uploadsInFlight.size > 0;
  }

  function clearRuntimeAfterRestore() {
    // A restore replaces the durable root state. Every process-local capability or
    // cache derived from the previous state must be invalidated with it; otherwise a
    // retry can observe an old completed-upload receipt or reuse a dedupe challenge
    // that was issued against the pre-restore filesystem/state graph.
    shareUploadLocks.clear();
    pendingModerationClaims.clear();
    uploadTransfers.clear();
    stoppedUploads.clear();
    uploadsInFlight.clear();
    completedUploadReceipts.clear();
    dedupeHashCache.clear();
    dedupeChallenges.clear();
    activePublicUploads = 0;
    lastPendingOrphanCleanupAt = 0;
  }

  return {
    collabRoot,
    receptionThreadArray,
    receptionThreadEnabled,
    publicThreadMessage,
    ownerThreadMessage,
    appendReceptionThreadMessage,
    receptionThreadUnreadCount,
    folderMetrics,
    folderBytes,
    acceptsUpload,
    normExtList,
    cleanSenderName,
    inboxContentReason,
    pendingModerationRows,
    pendingUsageForShare,
    releaseReceptionManagedBytes,
    safeManagedInboxFilePath,
    inboxRejectReason,
    inboxRejectStatus,
    receptionHashSeen,
    receptionMetadataPath,
    deleteFileExpiryForPath,
    rememberReceptionHash,
    receptionDuplicateStoredPath,
    receptionDuplicateReason,
    safeUploadRelPath,
    safeUploadFolderName,
    safeUploadParentSegments,
    senderSubdirSegs,
    senderTaggedName,
    uploadSenderKey,
    perSenderRejectReason,
    bumpSenderStat,
    reserveUniqueUploadPath,
    withShareUploadLock,
    claimPendingModeration,
    releasePendingModeration,
    stagePendingFileRemoval,
    stashPending,
    cleanupOrphanPendingFiles,
    applyReceptionAccountingState,
    finalizeReceptionAccountingEffects,
    rollbackReceptionAccountingState,
    rollbackAcceptedUploadFile,
    approvePendingModeration,
    finalizePendingModerationApproval,
    scanFile,
    quarantineFile,
    scanGate,
    safeUploadId,
    safeUploadByteCount,
    scopedUploadId,
    partPath,
    completedUploadReceipt,
    rememberCompletedUpload,
    beginPublicUpload,
    PARTS_DIR,
    PENDING_DIR,
    pendingModerationClaims,
    uploadTransfers,
    stoppedUploads,
    uploadsInFlight,
    validSha256Hex,
    rememberDedupeFile,
    findDedupeCandidate,
    verifyAndRememberDedupe,
    cleanupDedupeChallenges,
    makeDedupeRanges,
    verifyDedupeProof,
    dedupeChallenges,
    DEDUPE_CHALLENGE_TTL_MS,
    maybeCleanupOrphanPendingFiles,
    hasActiveUploads,
    clearRuntimeAfterRestore,
  };
}

module.exports = { createUploadReceptionService };
