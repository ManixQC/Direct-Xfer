'use strict';

const net = require('node:net');

const LIVE_ACTIVITY_MAX = 300;
const ACTIVITY_HISTORY_MAX = 2000;
const ACTIVITY_IGNORED_AUDIT_ACTIONS = new Set(['push-subscribed']);
const SSE_HEARTBEAT_MS = 20000;
const VALID_PRESENCE_SESSION_ROLES = new Set(['owner', 'admin', 'operator', 'auditor']);

function cleanActivityText(value, max) {
  return value == null ? null : String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function normalizePositiveTimestamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Owns the user-facing activity history, privacy projection and the two long-lived
 * SSE registries used by Direct-Xfer (activity and active-download presence).
 *
 * All state/domain dependencies are lazy callbacks so the composition root can
 * create this service before share, transfer and session services finish wiring.
 */
function createActivityPresenceService(deps = {}) {
  const {
    crypto,
    getState,
    getSettings,
    scheduleFlush,
    getShareById,
    getTrashItems,
    getPwaDevices,
    isSessionActive,
    getActiveTransfers,
    now = () => Date.now(),
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout,
    setIntervalRef = setInterval,
    clearIntervalRef = clearInterval,
  } = deps;

  if (!crypto || typeof crypto.randomBytes !== 'function' || typeof crypto.createHash !== 'function') {
    throw new TypeError('activity-presence-service requires crypto');
  }
  for (const [name, fn] of Object.entries({
    getState, getSettings, scheduleFlush, getShareById, getTrashItems,
    getPwaDevices, isSessionActive, getActiveTransfers,
  })) {
    if (typeof fn !== 'function') throw new TypeError(`activity-presence-service requires ${name}()`);
  }

  const liveActivityEvents = [];
  const liveActivityClients = new Set();
  const presenceClients = new Set();
  let presenceBroadcastTimer = null;
  let historyViewRevision = 0;

  function stateSnapshot() {
    const state = getState();
    return state && typeof state === 'object' ? state : {};
  }

  function expandIpv6(ip) {
    let value = String(ip || '').trim().toLowerCase();
    if (!value) return null;
    const zoneAt = value.indexOf('%');
    if (zoneAt >= 0) value = value.slice(0, zoneAt);
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);

    // Convert an embedded IPv4 tail into the two hextets used by IPv6 before
    // expanding ::. This keeps IPv4-mapped/compatible input deterministic.
    const ipv4Tail = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (ipv4Tail) {
      const octets = ipv4Tail[1].split('.').map(Number);
      if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      const hi = ((octets[0] << 8) | octets[1]).toString(16);
      const lo = ((octets[2] << 8) | octets[3]).toString(16);
      value = value.slice(0, value.length - ipv4Tail[1].length) + hi + ':' + lo;
    }

    if (!/^[0-9a-f:]+$/.test(value) || value.split('::').length > 2) return null;
    const [leftRaw, rightRaw = null] = value.split('::');
    const left = leftRaw ? leftRaw.split(':') : [];
    const right = rightRaw ? rightRaw.split(':') : [];
    if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    if (rightRaw === null) {
      if (left.length !== 8) return null;
      return left.map((part) => parseInt(part, 16));
    }
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    return [
      ...left.map((part) => parseInt(part, 16)),
      ...new Array(missing).fill(0),
      ...right.map((part) => parseInt(part, 16)),
    ];
  }

  function maskIp(ip) {
    let s = String(ip || '').trim();
    if (!s) return s;

    // Keep already-anonymized values idempotent. This matters because several
    // call paths persist a projected IP and later pass it through pubIp() again.
    if (/^anon-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase();
    const maskedV4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.x$/i);
    if (maskedV4 && maskedV4.slice(1).every((part) => Number(part) <= 255)) {
      return `${Number(maskedV4[1])}.${Number(maskedV4[2])}.${Number(maskedV4[3])}.x`;
    }

    // Normalize the host portion when an HTTP/network helper gives us a socket
    // address (IPv4:port or [IPv6]:port). Privacy must apply to the address, not
    // fail open merely because transport metadata was appended.
    const bracketed = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (bracketed) {
      if (bracketed[2] && Number(bracketed[2]) > 65535) return anonymizedUnknown(s);
      s = bracketed[1];
    } else {
      const ipv4Port = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
      if (ipv4Port) {
        if (Number(ipv4Port[2]) > 65535) return anonymizedUnknown(s);
        s = ipv4Port[1];
      }
    }

    const zoneAt = s.indexOf('%');
    if (zoneAt >= 0) s = s.slice(0, zoneAt);
    const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) s = mapped[1];

    if (net.isIP(s) === 4) {
      const parts = s.split('.');
      parts[3] = 'x';
      return parts.join('.');
    }
    if (net.isIP(s) === 6) {
      const groups = expandIpv6(s);
      if (groups) {
        // Canonicalize hexadecimal IPv4-mapped IPv6 too (for example
        // ::ffff:cb00:712a). Node/proxies may surface the same peer either as
        // dotted mapped IPv6 or pure hextets. Treating the hextet form as /48
        // collapsed every mapped IPv4 peer into 0:0:0::, which could merge
        // unrelated quota/rate-limit/notification identities.
        const mappedHex = groups.length === 8
          && groups.slice(0, 5).every((n) => n === 0)
          && groups[5] === 0xffff;
        if (mappedHex) {
          const hi = groups[6], lo = groups[7];
          return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.x`;
        }
        return groups.slice(0, 3).map((n) => n.toString(16)).join(':') + '::';
      }
    }

    // A malformed/restored value must never bypass anonymization by being echoed
    // verbatim. Use a stable pseudonym so repeated records can still be correlated
    // without exposing the original string.
    return anonymizedUnknown(s);
  }

  function anonymizedUnknown(value) {
    return 'anon-' + crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
  }

  function pubIp(ip) {
    const settings = getSettings() || {};
    return settings.anonymizeIps ? maskIp(ip) : ip;
  }

  function ipNameFor(ip) {
    const settings = getSettings() || {};
    if (settings.keepIpNames === false) return null;
    const state = stateSnapshot();
    return (ip && state.ipNames && state.ipNames[ip]) || null;
  }

  function listHistory(allowedShareIds) {
    const state = stateSnapshot();
    const history = Array.isArray(state.history) ? state.history : [];
    const settings = getSettings() || {};
    const names = settings.keepIpNames === false || !state.ipNames || typeof state.ipNames !== 'object' ? null : state.ipNames;
    return history
      .filter((record) => record && typeof record === 'object' && !Array.isArray(record) && (!allowedShareIds || allowedShareIds.has(record.shareId)))
      .map((record) => {
        const ip = settings.anonymizeIps ? maskIp(record.ip) : record.ip;
        return { ...record, ip, ipName:(names && ip && names[ip]) || null };
      });
  }

  function historyMeta(allowedShareIds) {
    const state = stateSnapshot();
    const history = Array.isArray(state.history) ? state.history : [];
    let count = 0;
    let latest = null;
    for (const record of history) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || (allowedShareIds && !allowedShareIds.has(record.shareId))) continue;
      count += 1;
      if (!latest) latest = record;
    }
    return {
      count,
      latestId: latest ? latest.id : null,
      latestAt: latest ? (latest.endedAt || latest.startedAt || 0) : 0,
      viewRevision: historyViewRevision,
    };
  }

  function getHistoryViewRevision() {
    return historyViewRevision;
  }

  function setHistoryViewRevision(revision) {
    const n = Number(revision);
    historyViewRevision = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    return historyViewRevision;
  }

  function bumpHistoryViewRevision() {
    historyViewRevision += 1;
    return historyViewRevision;
  }

  function activityAuditAction(event) {
    if (!event || String(event.kind || '') !== 'audit') return '';
    return String(event.status || event.name || '').trim();
  }

  function isActivityIgnored(action) {
    return ACTIVITY_IGNORED_AUDIT_ACTIONS.has(String(action || '').trim());
  }

  function activityEventVisible(event) {
    return !isActivityIgnored(activityAuditAction(event));
  }

  function sanitizeActivityEvent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const fallbackNow = now();
    return {
      id: /^[A-Za-z0-9_-]{4,64}$/.test(String(raw.id || ''))
        ? String(raw.id)
        : crypto.randomBytes(6).toString('hex'),
      at: normalizePositiveTimestamp(raw.at, fallbackNow),
      kind: cleanActivityText(raw.kind || 'event', 40) || 'event',
      shareId: raw.shareId ? String(raw.shareId).slice(0, 128) : null,
      name: raw.name ? cleanActivityText(raw.name, 220) : null,
      direction: raw.direction === 'up' ? 'up' : raw.direction === 'down' ? 'down' : null,
      bytes: Number.isFinite(Number(raw.bytes)) ? Math.floor(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(raw.bytes)))) : 0,
      status: raw.status ? cleanActivityText(raw.status, 40) : null,
      detail: raw.detail != null ? cleanActivityText(raw.detail, 300) : null,
      ip: raw.ip ? cleanActivityText(raw.ip, 100) : null,
      actor: raw.actor ? cleanActivityText(raw.actor, 120) : null,
      accountId: raw.accountId ? String(raw.accountId).slice(0, 120) : null,
      deviceId: raw.deviceId ? String(raw.deviceId).slice(0, 120) : null,
    };
  }

  function safeShareById(id) {
    try { return getShareById(id) || null; } catch (_) { return null; }
  }

  function safeTrashItems() {
    try {
      const items = getTrashItems();
      return Array.isArray(items) ? items : [];
    } catch (_) { return []; }
  }

  function safePwaDevices() {
    try {
      const devices = getPwaDevices();
      return Array.isArray(devices) ? devices : [];
    } catch (_) { return []; }
  }

  function activityProjectionContext(events = []) {
    const rows = Array.isArray(events) ? events : [events];
    const shareById = new Map();
    const missingShareIds = new Set();
    const deviceIds = new Set();
    for (const event of rows) {
      if (!event || typeof event !== 'object') continue;
      if (event.shareId) {
        const id = String(event.shareId);
        if (!shareById.has(id) && !missingShareIds.has(id)) {
          const share = safeShareById(id);
          if (share) shareById.set(id, share);
          else missingShareIds.add(id);
        }
      }
      if (event.deviceId) deviceIds.add(String(event.deviceId));
    }
    if (missingShareIds.size) {
      for (const row of safeTrashItems()) {
        if (!row || !row.share || row.share.id == null) continue;
        const id = String(row.share.id);
        if (missingShareIds.has(id) && !shareById.has(id)) shareById.set(id, row.share);
      }
    }
    const deviceById = new Map();
    if (deviceIds.size) {
      for (const row of safePwaDevices()) {
        if (!row || row.id == null) continue;
        const id = String(row.id);
        if (deviceIds.has(id) && !deviceById.has(id)) deviceById.set(id, row);
      }
    }
    return { shareById, deviceById };
  }

  function projectActivityEvent(event, context) {
    if (!event) return event;
    const ctx = context || activityProjectionContext([event]);
    let share = null;
    if (event.shareId) share = ctx.shareById.get(String(event.shareId)) || null;
    const detailType = /^(file|folder|inbox|collab|photo|album|secret)$/i.test(String(event.detail || ''))
      ? String(event.detail).toLowerCase()
      : null;
    let auditType = null;
    if (String(event.kind || '') === 'audit') {
      const action = String(event.status || event.name || '').toLowerCase();
      if (/^album-/.test(action)) auditType = 'album';
      else if (/^(?:image|photo|photos)-/.test(action)) auditType = 'photo';
      else if (/^(?:inbox|reception)-/.test(action)) auditType = 'inbox';
      else if (/^collab-/.test(action)) auditType = 'collab';
    }
    const resourceType = event.resourceType || (share && share.type) || detailType || auditType || null;
    const source = event.source || (event.deviceId || /^PWA(?::|$)/i.test(String(event.actor || '')) || /via PWA/i.test(String(event.detail || '')) ? 'pwa' : 'standard');
    const device = event.deviceId ? (ctx.deviceById.get(String(event.deviceId)) || null) : null;
    return {
      ...event,
      resourceType,
      source,
      deviceName: device ? (device.name || null) : null,
      shareName: share ? (share.name || null) : null,
      correlationId: event.shareId || null,
    };
  }

  function activityEventForClient(event) {
    return projectActivityEvent(event, activityProjectionContext([event]));
  }

  function activityEventsForClient(events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const context = activityProjectionContext(events);
    return events.map((event) => projectActivityEvent(event, context));
  }

  function sanitizeActivityLog(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const row of raw) {
      const event = sanitizeActivityEvent(row);
      if (!event || !activityEventVisible(event) || seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
      if (out.length >= ACTIVITY_HISTORY_MAX) break;
    }
    return out;
  }

  function syncLiveActivityCache() {
    const activityLog = sanitizeActivityLog(stateSnapshot().activityLog);
    liveActivityEvents.splice(0, liveActivityEvents.length, ...activityLog.slice(0, LIVE_ACTIVITY_MAX));
  }

  function buildLegacyActivityLog(auditRows, transferRows) {
    const rows = [];
    for (const entry of Array.isArray(auditRows) ? auditRows : []) {
      if (!entry || !entry.action) continue;
      rows.push(sanitizeActivityEvent({
        id: 'legacy-a-' + String(entry.seq || crypto.createHash('sha1').update(JSON.stringify([entry.at, entry.action, entry.actor, entry.detail])).digest('hex').slice(0, 16)),
        at: entry.at,
        kind: 'audit',
        name: entry.action,
        status: entry.action,
        detail: entry.detail,
        ip: entry.ip ? pubIp(entry.ip) : null,
        actor: entry.actor || null,
        accountId: entry.actorId || null,
      }));
    }
    for (const transfer of Array.isArray(transferRows) ? transferRows : []) {
      if (!transfer || !transfer.shareId) continue;
      const completed = transfer.completed !== false;
      rows.push(sanitizeActivityEvent({
        id: 'legacy-t-' + String(transfer.id || crypto.createHash('sha1').update(JSON.stringify([transfer.shareId, transfer.endedAt, transfer.name, transfer.bytes])).digest('hex').slice(0, 16)),
        at: transfer.endedAt || transfer.startedAt,
        kind: completed ? 'transfer-complete' : 'transfer-error',
        shareId: transfer.shareId,
        name: transfer.name || transfer.shareName || transfer.shareId,
        direction: transfer.direction,
        bytes: transfer.bytes,
        status: completed ? 'completed' : 'interrupted',
        detail: completed ? (transfer.sender ? 'from ' + transfer.sender : null) : (transfer.reason || transfer.failureReason || 'interrupted'),
        ip: transfer.ip ? pubIp(transfer.ip) : null,
      }));
    }
    return sanitizeActivityLog(rows.filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0)));
  }

  function clearClientHeartbeat(client) {
    if (!client || !client.heartbeat) return;
    try { clearIntervalRef(client.heartbeat); } catch (_) {}
    client.heartbeat = null;
  }

  function clearClientDrain(client) {
    if (!client || !client.drainHandler || !client.res) return;
    try {
      if (typeof client.res.off === 'function') client.res.off('drain', client.drainHandler);
      else if (typeof client.res.removeListener === 'function') client.res.removeListener('drain', client.drainHandler);
    } catch (_) {}
    client.drainHandler = null;
    client.drainAttached = false;
  }

  function endStreamResponse(res, statusCode) {
    if (!res) return;
    try {
      if (statusCode && !res.headersSent && typeof res.status === 'function') res.status(statusCode);
      if (!res.writableEnded && typeof res.end === 'function') res.end();
    } catch (_) {}
  }

  function attachStreamCleanup(res, cleanup) {
    if (!res || typeof res.on !== 'function' || typeof cleanup !== 'function') return false;
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      try { cleanup(); } catch (_) {}
    };
    res.on('close', once);
    res.on('finish', once);
    res.on('error', once);
    return true;
  }

  function activitySnapshotLine(limitValue) {
    const limit = Math.max(1, Math.min(1000, Number(limitValue) || 500));
    const activityLog = sanitizeActivityLog(stateSnapshot().activityLog).slice(0, limit);
    const snapshot = activityEventsForClient(activityLog).reverse();
    return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }

  function armActivityDrain(client) {
    if (!client || client.closed || !client.res) return false;
    if (client.drainAttached) return true;
    if (typeof client.res.once !== 'function') return false;
    client.drainAttached = true;
    client.drainHandler = () => {
      client.drainAttached = false;
      client.drainHandler = null;
      if (client.closed) return;
      if (!liveActivityClientAuthorized(client)) { dropLiveActivityClient(client); return; }
      client.backpressured = false;
      if (!client.needsActivitySnapshot) return;
      client.needsActivitySnapshot = false;
      try {
        const accepted = client.res.write(activitySnapshotLine(client.snapshotLimit));
        if (accepted === false) {
          client.backpressured = true;
          if (!armActivityDrain(client)) dropLiveActivityClient(client);
        }
      } catch (_) { dropLiveActivityClient(client); }
    };
    try {
      client.res.once('drain', client.drainHandler);
      return true;
    } catch (_) {
      client.drainAttached = false;
      client.drainHandler = null;
      return false;
    }
  }

  function writeActivityClient(client, line) {
    if (!client || !client.res || client.res.writableEnded || client.closed) return false;
    if (client.backpressured) {
      client.needsActivitySnapshot = true;
      return true;
    }
    try {
      const accepted = client.res.write(line);
      if (accepted === false) {
        client.backpressured = true;
        if (!armActivityDrain(client)) return false;
      }
      return true;
    } catch (_) { return false; }
  }

  function liveActivityClientAuthorized(client) {
    if (!client || !client.sid) return false;
    try { return !!isSessionActive(client.sid, ['owner', 'admin', 'auditor']); } catch (_) { return false; }
  }

  function dropLiveActivityClient(client) {
    liveActivityClients.delete(client);
    clearClientHeartbeat(client);
    clearClientDrain(client);
    if (client) client.closed = true;
    endStreamResponse(client && client.res);
  }

  function emitLiveActivity(kind, data) {
    const payload = data && typeof data === 'object' ? data : {};
    const event = sanitizeActivityEvent({
      id: crypto.randomBytes(6).toString('hex'),
      at: now(),
      kind,
      shareId: payload.shareId,
      name: payload.name,
      direction: payload.direction,
      bytes: payload.bytes,
      status: payload.status,
      detail: payload.detail,
      ip: payload.ip,
      actor: payload.actor,
      accountId: payload.accountId,
      deviceId: payload.deviceId,
    });
    const state = stateSnapshot();
    if (!Array.isArray(state.activityLog)) state.activityLog = [];
    state.activityLog.unshift(event);
    if (state.activityLog.length > ACTIVITY_HISTORY_MAX) state.activityLog.length = ACTIVITY_HISTORY_MAX;
    liveActivityEvents.unshift(event);
    if (liveActivityEvents.length > LIVE_ACTIVITY_MAX) liveActivityEvents.length = LIVE_ACTIVITY_MAX;
    scheduleFlush();
    const line = `id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(activityEventForClient(event))}\n\n`;
    for (const client of [...liveActivityClients]) {
      if (!liveActivityClientAuthorized(client)) {
        dropLiveActivityClient(client);
        continue;
      }
      if (!writeActivityClient(client, line)) dropLiveActivityClient(client);
    }
    return event;
  }

  function openLiveActivityStream(res, sid, snapshotLimit = 500) {
    const limit = Math.max(1, Math.min(1000, Number(snapshotLimit) || 500));
    const client = { res, sid, heartbeat:null, closed:false, backpressured:false, needsActivitySnapshot:false, snapshotLimit:limit, drainAttached:false, drainHandler:null };
    // Defense in depth: the route already checks requireAuditAccess, but the
    // service must never emit the sensitive snapshot before it has independently
    // revalidated the long-lived session.
    if (!liveActivityClientAuthorized(client)) {
      endStreamResponse(res, 403);
      return null;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    try {
      const accepted = res.write(activitySnapshotLine(limit));
      if (accepted === false) client.backpressured = true;
    } catch (_) {
      endStreamResponse(res);
      return null;
    }

    liveActivityClients.add(client);
    if (client.backpressured && !armActivityDrain(client)) {
      dropLiveActivityClient(client);
      return null;
    }
    client.heartbeat = setIntervalRef(() => {
      if (!liveActivityClientAuthorized(client)) {
        dropLiveActivityClient(client);
        return;
      }
      if (client.backpressured) return;
      try {
        const accepted = res.write(': heartbeat\n\n');
        if (accepted === false) {
          client.backpressured = true;
          if (!armActivityDrain(client)) dropLiveActivityClient(client);
        }
      } catch (_) { dropLiveActivityClient(client); }
    }, SSE_HEARTBEAT_MS);
    if (client.heartbeat && client.heartbeat.unref) client.heartbeat.unref();
    attachStreamCleanup(res, () => {
      liveActivityClients.delete(client);
      clearClientHeartbeat(client);
      clearClientDrain(client);
      client.needsActivitySnapshot = false;
      client.backpressured = false;
      client.closed = true;
    });
    return client;
  }

  function recentActivityPayload(limitValue) {
    const limit = Math.max(1, Math.min(1000, Number(limitValue) || 500));
    const activityLog = sanitizeActivityLog(stateSnapshot().activityLog);
    return {
      events: activityEventsForClient(activityLog.slice(0, limit)),
      retained: activityLog.length,
      max: ACTIVITY_HISTORY_MAX,
    };
  }

  function activeDownloadCounts() {
    const counts = new Map();
    let transfers;
    try { transfers = getActiveTransfers(); } catch (_) { transfers = null; }
    if (!transfers || typeof transfers.values !== 'function') return counts;
    for (const transfer of transfers.values()) {
      if (!transfer || !transfer.shareId || (transfer.direction || 'down') !== 'down' || !transfer.notify) continue;
      counts.set(transfer.shareId, (counts.get(transfer.shareId) || 0) + 1);
    }
    return counts;
  }

  function presenceClientAuthorized(client) {
    if (!client || typeof client.validate !== 'function') return false;
    try { return !!client.validate(); } catch (_) { return false; }
  }

  function presenceSessionValidator(sid, allowedRoles) {
    const sourceRoles = Array.isArray(allowedRoles)
      ? allowedRoles
      : ['owner', 'admin', 'operator', 'auditor'];
    const roles = [...new Set(sourceRoles
      .map((role) => String(role || '').trim())
      .filter((role) => VALID_PRESENCE_SESSION_ROLES.has(role)))]
      .slice(0, VALID_PRESENCE_SESSION_ROLES.size);
    return function validatePresenceSession() {
      // An explicitly supplied but empty/invalid privilege set must fail closed.
      // This protects future callers from accidentally turning a malformed role
      // policy into an unrestricted `isSessionActive(sid)` check.
      if (!sid || roles.length === 0) return false;
      try { return !!isSessionActive(sid, roles); } catch (_) { return false; }
    };
  }

  function dropPresenceClient(client) {
    presenceClients.delete(client);
    clearClientHeartbeat(client);
    clearClientDrain(client);
    if (client) client.closed = true;
    endStreamResponse(client && client.res);
    if (presenceClients.size === 0 && presenceBroadcastTimer) {
      try { clearTimeoutRef(presenceBroadcastTimer); } catch (_) {}
      presenceBroadcastTimer = null;
    }
  }

  function presencePayloadFor(client, counts) {
    const out = {};
    if (!counts || typeof counts[Symbol.iterator] !== 'function') return out;
    for (const entry of counts) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const shareId = String(entry[0] == null ? '' : entry[0]);
      const n = Number(entry[1]);
      if (!shareId || !Number.isFinite(n) || n <= 0) continue;
      if (!client || !client.seeAll) {
        const share = safeShareById(shareId);
        if (!share || !share.ownerId || String(share.ownerId) !== String((client && client.accountId) || '')) continue;
      }
      Object.defineProperty(out, shareId, {
        value: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n)),
        enumerable: true, configurable: true, writable: true,
      });
    }
    return out;
  }

  function presenceSnapshot(scope) {
    return { counts: presencePayloadFor(scope || {}, activeDownloadCounts()) };
  }

  function armPresenceDrain(client) {
    if (!client || client.closed || !client.res) return false;
    if (client.drainAttached) return true;
    if (typeof client.res.once !== 'function') return false;
    client.drainAttached = true;
    client.drainHandler = () => {
      client.drainAttached = false;
      client.drainHandler = null;
      if (client.closed) return;
      if (!presenceClientAuthorized(client)) { dropPresenceClient(client); return; }
      client.backpressured = false;
      if (!client.pendingPresence) return;
      client.pendingPresence = false;
      if (!writePresence(client, activeDownloadCounts())) dropPresenceClient(client);
    };
    try {
      client.res.once('drain', client.drainHandler);
      return true;
    } catch (_) {
      client.drainAttached = false;
      client.drainHandler = null;
      return false;
    }
  }

  function writePresence(client, counts) {
    try {
      if (!client || !client.res || client.res.writableEnded || client.closed) return false;
      if (client.backpressured) {
        client.pendingPresence = true;
        return true;
      }
      const accepted = client.res.write(`event: presence\ndata: ${JSON.stringify({ counts: presencePayloadFor(client, counts) })}\n\n`);
      if (accepted === false) {
        client.backpressured = true;
        if (!armPresenceDrain(client)) return false;
      }
      return true;
    } catch (_) { return false; }
  }

  function schedulePresenceBroadcast() {
    if (presenceBroadcastTimer || presenceClients.size === 0) return;
    presenceBroadcastTimer = setTimeoutRef(() => {
      presenceBroadcastTimer = null;
      const counts = activeDownloadCounts();
      for (const client of [...presenceClients]) {
        if (!presenceClientAuthorized(client)) {
          dropPresenceClient(client);
          continue;
        }
        if (!writePresence(client, counts)) dropPresenceClient(client);
      }
    }, 400);
    if (presenceBroadcastTimer && presenceBroadcastTimer.unref) presenceBroadcastTimer.unref();
  }

  function openPresenceStream(res, scope = {}, validate) {
    const client = {
      res,
      seeAll: !!scope.seeAll,
      accountId: scope.accountId || null,
      validate,
      heartbeat:null,
      closed:false,
      backpressured:false,
      pendingPresence:false,
      drainAttached:false,
      drainHandler:null,
    };
    if (!presenceClientAuthorized(client)) {
      endStreamResponse(res, 403);
      return null;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    if (!writePresence(client, activeDownloadCounts())) {
      endStreamResponse(res);
      return null;
    }
    presenceClients.add(client);
    client.heartbeat = setIntervalRef(() => {
      if (!presenceClientAuthorized(client)) {
        dropPresenceClient(client);
        return;
      }
      if (client.backpressured) return;
      try {
        const accepted = res.write(': heartbeat\n\n');
        if (accepted === false) {
          client.backpressured = true;
          if (!armPresenceDrain(client)) dropPresenceClient(client);
        }
      } catch (_) { dropPresenceClient(client); }
    }, SSE_HEARTBEAT_MS);
    if (client.heartbeat && client.heartbeat.unref) client.heartbeat.unref();
    attachStreamCleanup(res, () => {
      presenceClients.delete(client);
      clearClientHeartbeat(client);
      clearClientDrain(client);
      client.pendingPresence = false;
      client.backpressured = false;
      client.closed = true;
      if (presenceClients.size === 0 && presenceBroadcastTimer) {
        try { clearTimeoutRef(presenceBroadcastTimer); } catch (_) {}
        presenceBroadcastTimer = null;
      }
    });
    return client;
  }

  function closeLiveActivityClients() {
    for (const client of [...liveActivityClients]) dropLiveActivityClient(client);
  }

  function closePresenceClients() {
    for (const client of [...presenceClients]) dropPresenceClient(client);
  }

  function closeActivityPresenceStreams() {
    if (presenceBroadcastTimer) {
      try { clearTimeoutRef(presenceBroadcastTimer); } catch (_) {}
      presenceBroadcastTimer = null;
    }
    closeLiveActivityClients();
    closePresenceClients();
  }

  function clearRuntimeStreams() {
    closeActivityPresenceStreams();
    liveActivityEvents.length = 0;
  }

  return {
    constants: Object.freeze({ LIVE_ACTIVITY_MAX, ACTIVITY_HISTORY_MAX }),
    liveActivityEvents,
    liveActivityClients,
    presenceClients,
    maskIp,
    pubIp,
    ipNameFor,
    listHistory,
    historyMeta,
    getHistoryViewRevision,
    setHistoryViewRevision,
    bumpHistoryViewRevision,
    isActivityIgnored,
    sanitizeActivityEvent,
    activityEventForClient,
    activityEventsForClient,
    sanitizeActivityLog,
    syncLiveActivityCache,
    buildLegacyActivityLog,
    liveActivityClientAuthorized,
    dropLiveActivityClient,
    emitLiveActivity,
    openLiveActivityStream,
    recentActivityPayload,
    activeDownloadCounts,
    presenceClientAuthorized,
    presenceSessionValidator,
    dropPresenceClient,
    presencePayloadFor,
    presenceSnapshot,
    schedulePresenceBroadcast,
    openPresenceStream,
    closeLiveActivityClients,
    closePresenceClients,
    closeActivityPresenceStreams,
    clearRuntimeStreams,
  };
}

module.exports = {
  LIVE_ACTIVITY_MAX,
  ACTIVITY_HISTORY_MAX,
  createActivityPresenceService,
};
