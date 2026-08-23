'use strict';

const net = require('node:net');
const { photoExt } = require('../photo-utils');

function externalProto(req) {
  // Express only honors X-Forwarded-Proto when the application trusts the peer.
  return req && req.protocol === 'https' ? 'https' : 'http';
}

function hostIsIpLiteral(host) {
  const value = String(host || '').trim();
  if (!value) return false;
  if (value[0] === '[') return true;
  let bare = value;
  const colon = bare.indexOf(':');
  if (colon !== -1 && colon === bare.lastIndexOf(':')) bare = bare.slice(0, colon);
  if (net.isIP(bare)) return true;
  // WHATWG canonicalizes legacy IPv4 notations such as 127.1, 0x7f000001,
  // and 2130706433. Treat those as IP literals too; otherwise a trusted Host
  // header could disguise a loopback/private IP as a domain-looking value.
  try {
    let canonical = new URL(`http://${value}`).hostname;
    if (canonical[0] === '[' && canonical.endsWith(']')) canonical = canonical.slice(1, -1);
    return net.isIP(canonical) !== 0;
  } catch (_) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  }
}

// Returns an origin, an empty string for an empty value, or null when invalid.
function normalizeLinkBase(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return '';
  // Do not reinterpret an explicitly unsupported scheme as a hostname. For
  // example, `ftp://host` previously became the surprising `https://ftp`.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !/^https?:\/\//i.test(value)) return null;
  // URI schemes without // (mailto:, javascript:, data:, ...) must not be
  // reinterpreted as a hostname. A bare host:port remains supported.
  const schemeLike = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/);
  if (schemeLike && !/^https?$/i.test(schemeLike[1]) && !/^\d+$/.test(schemeLike[2])) return null;
  // WHATWG URL parsing removes some ASCII whitespace. Reject controls up front
  // so a restored/corrupt setting cannot be normalized into a different host.
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  value = value.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) {
    value = (/:\d+$/.test(value) ? 'http://' : 'https://') + value;
  }
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    return null;
  }
}

function requiredFunction(options, name) {
  const value = options[name];
  if (typeof value !== 'function') throw new TypeError(`share-presentation-service requires ${name}()`);
  return value;
}

function requiredService(getter, name) {
  const service = getter();
  if (!service || typeof service !== 'object') throw new Error(`${name} is not available`);
  return service;
}

function createSharePresentationService(options = {}) {
  const config = options.config || {};
  const PUBLIC_URL = String(config.PUBLIC_URL || '');
  const PUBLIC_HOST = String(config.PUBLIC_HOST || '');
  const PORT = Number(config.PORT) || 55750;
  const TRUST_PROXY = config.TRUST_PROXY;
  const getSettings = requiredFunction(options, 'getSettings');
  const getState = requiredFunction(options, 'getState');
  const getPublicIPCached = requiredFunction(options, 'getPublicIPCached');
  const getLocalIPv4s = requiredFunction(options, 'getLocalIPv4s');
  const getShareService = requiredFunction(options, 'getShareService');
  const getPhotoService = requiredFunction(options, 'getPhotoService');
  const getPwaDeviceService = requiredFunction(options, 'getPwaDeviceService');
  const pubIp = requiredFunction(options, 'pubIp');

  function currentSettings() {
    const settings = getSettings();
    return settings && typeof settings === 'object' ? settings : {};
  }

  function trustedProxyOrigin(req) {
    if (!TRUST_PROXY || !req || typeof req.get !== 'function') return '';
    const host = String(req.get('host') || '').trim();
    if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host) || hostIsIpLiteral(host)) return '';
    try {
      const parsed = new URL(`http://${host}`);
      if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
      return `${externalProto(req)}://${parsed.host}`;
    } catch (_) { return ''; }
  }

  // Link URL base: configured domain > PUBLIC_URL > reverse-proxy domain >
  // PUBLIC_HOST > public IP > local IP.
  function resolvePrimaryBase(req, settings) {
    const configured = normalizeLinkBase(settings && settings.linkBase);
    if (configured) return configured;
    if (PUBLIC_URL) return PUBLIC_URL;
    const proxyOrigin = trustedProxyOrigin(req);
    if (proxyOrigin) return proxyOrigin;
    if (PUBLIC_HOST) return `http://${PUBLIC_HOST}:${PORT}`;
    const publicIp = getPublicIPCached();
    if (publicIp) return `http://${publicIp}:${PORT}`;
    const locals = getLocalIPv4s();
    if (Array.isArray(locals) && locals.length && locals[0] && locals[0].address) return `http://${locals[0].address}:${PORT}`;
    return '';
  }

  function primaryBase(req) {
    return resolvePrimaryBase(req, currentSettings());
  }

  function resolveImageBase(settings, fallbackBase) {
    return normalizeLinkBase(settings && settings.imageBase) || fallbackBase || '';
  }

  function decorateShare(shareRecord, req, context = null) {
    if (!shareRecord || typeof shareRecord !== 'object') throw new TypeError('decorateShare requires a share record');
    const shareService = requiredService(getShareService, 'share-service');
    const state = getState();
    const settings = currentSettings();
    const baseline = shareService.shareStatsBaseline(shareRecord);
    const active = shareService.isActive(shareRecord);
    const items = shareService.shareItems(shareRecord);
    const rel = shareService.linkPrefix(shareRecord) + shareRecord.token;
    const base = context && Object.prototype.hasOwnProperty.call(context, 'base')
      ? context.base
      : resolvePrimaryBase(req, settings);

    return {
      id: shareRecord.id,
      token: shareRecord.token,
      type: shareRecord.type,
      name: shareRecord.name,
      hostPath: shareRecord.hostPath,
      relDir: shareRecord.relDir,
      size: shareRecord.size,
      createdAt: shareRecord.createdAt,
      startsAt: shareRecord.startsAt || null,
      expiresAt: shareRecord.expiresAt,
      effectiveExpiresAt: shareService.shareEffectiveExpiry(shareRecord),
      maxDownloads: shareRecord.maxDownloads,
      downloadsUsed: shareRecord.downloads || 0,
      downloads: Math.max(0, (shareRecord.downloads || 0) - baseline.downloads),
      maxVisitors: shareService.parseMaxVisitors(shareRecord.maxVisitors),
      notifyDownloadThreshold: shareRecord.notifyDownloadThreshold || 0,
      downloadThresholdReached: !!shareRecord.downloadThresholdNotifiedAt,
      uniqueVisitorsUsed: Array.isArray(shareRecord.visitors) ? shareRecord.visitors.length : 0,
      uniqueVisitors: Math.max(0, (Array.isArray(shareRecord.visitors) ? shareRecord.visitors.length : 0) - baseline.visitors),
      views: Math.max(0, (shareRecord.views || 0) - baseline.views),
      pinned: !!shareRecord.pinned,
      archived: !!shareRecord.archived,
      logicalBytes: shareService.shareLogicalBytes(shareRecord),
      logicalBytesReady: shareRecord.webStorage && shareRecord.webStorage.isDir
        ? false
        : (!shareService.shareNeedsLogicalBytesScan(shareRecord) || !!shareService.shareLogicalBytesCache.get(shareRecord.id)),
      backing: shareService.shareBackingHealthSnapshot(shareRecord),
      itemCount: shareService.shareLogicalFileCount(shareRecord),
      lastActivityAt: shareService.shareActivityAt(shareRecord),
      lastUseAt: shareService.shareLastUseAt(shareRecord),
      lastDownload: shareRecord.lastDownload ? { ...shareRecord.lastDownload, ip: pubIp(shareRecord.lastDownload.ip) } : null,
      lastUpload: shareRecord.lastUpload ? { ...shareRecord.lastUpload, ip: pubIp(shareRecord.lastUpload.ip) } : null,
      expirySetAt: shareRecord.expirySetAt || shareRecord.createdAt || null,
      inactiveExpiresAt: shareService.shareInactiveDeadline(shareRecord),
      firstUsedAt: shareRecord.firstUsedAt || null,
      firstUseExpiresAt: shareService.shareFirstUseDeadline(shareRecord),
      firstUseExpirySeconds: Math.max(0, Number(shareRecord.firstUseExpirySeconds) || 0),
      inactiveExpirySeconds: Math.max(0, Number(shareRecord.inactiveExpirySeconds) || 0),
      expiryReminderHours: shareRecord.expiryReminderHours == null ? null : Number(shareRecord.expiryReminderHours),
      color: shareRecord.color || '',
      descriptionMd: shareRecord.descriptionMd || '',
      commentCount: Array.isArray(shareRecord.adminComments) ? shareRecord.adminComments.length : 0,
      lastComment: Array.isArray(shareRecord.adminComments) && shareRecord.adminComments.length ? shareRecord.adminComments[0] : null,
      requestAccess: !!shareRecord.requestAccess,
      accessPending: Array.isArray(shareRecord.accessRequests) ? shareRecord.accessRequests.filter((row) => row && row.status === 'pending').length : 0,
      accessRequestsCount: Array.isArray(shareRecord.accessRequests) ? shareRecord.accessRequests.length : 0,
      allowFeedback: !!shareRecord.allowFeedback,
      feedbackCount: Array.isArray(shareRecord.visitorFeedback) ? shareRecord.visitorFeedback.length : 0,
      feedbackUnread: Array.isArray(shareRecord.visitorFeedback) ? shareRecord.visitorFeedback.filter((row) => row && !row.read).length : 0,
      statsResetAt: shareRecord.statsBaseline && shareRecord.statsBaseline.at || null,
      changeCount: Array.isArray(shareRecord.changeHistory) ? shareRecord.changeHistory.length : 0,
      dlp: shareRecord.dlp ? { ...shareRecord.dlp } : null,
      favorite: shareRecord.type === 'photo' ? !!shareRecord.favorite : false,
      photo: shareRecord.type === 'photo' ? (() => {
        const photoService = requiredService(getPhotoService, 'photo-service');
        const pwaDeviceService = requiredService(getPwaDeviceService, 'pwa-device-service');
        const imageBase = resolveImageBase(settings, base);
        const stats = photoService.photoStatsOf(shareRecord);
        const revision = photoService.photoCacheRevision(shareRecord);
        const queryVersion = '?v=' + encodeURIComponent(revision);
        const extension = photoExt(shareRecord);
        return {
          ext: extension,
          imgUrl: (imageBase ? imageBase + '/i/' + shareRecord.token + '.' + extension : ('/i/' + shareRecord.token + '.' + extension)) + queryVersion,
          thumbUrl: (imageBase ? imageBase + '/i/' + shareRecord.token + '/thumb' : ('/i/' + shareRecord.token + '/thumb')) + queryVersion,
          microUrl: (imageBase ? imageBase + '/i/' + shareRecord.token + '/micro' : ('/i/' + shareRecord.token + '/micro')) + queryVersion,
          hasThumb: !!shareRecord.thumb,
          hasMicro: !!shareRecord.micro,
          fullViews: stats.full.v || 0,
          fullVisitors: Array.isArray(stats.full.u) ? stats.full.u.length : 0,
          thumbViews: stats.thumb.v || 0,
          thumbVisitors: Array.isArray(stats.thumb.u) ? stats.thumb.u.length : 0,
          microViews: stats.micro.v || 0,
          microVisitors: Array.isArray(stats.micro.u) ? stats.micro.u.length : 0,
          w: shareRecord.w || null,
          h: shareRecord.h || null,
          uploadDeviceName: pwaDeviceService.photoUploadDeviceName(shareRecord),
          metadataRemoved: !!shareRecord.metadataRemoved,
          cacheRevision: revision,
          versionCount: Array.isArray(shareRecord.versions) ? shareRecord.versions.length : 0,
          editHistoryCount: Array.isArray(shareRecord.editHistory) ? shareRecord.editHistory.length : 0,
        };
      })() : null,
      webStorage: shareRecord.webStorage ? {
        connectorId: String(shareRecord.webStorage.connectorId || ''),
        connectorName: String(shareRecord.webStorage.connectorName || '').slice(0, 80),
        connectorType: String(shareRecord.webStorage.connectorType || '').slice(0, 40),
        path: String(shareRecord.webStorage.path || '').slice(0, 4096),
        isDir: !!shareRecord.webStorage.isDir,
        sourceName: String(shareRecord.webStorage.sourceName || '').slice(0, 255),
      } : null,
      album: shareRecord.type === 'album' ? (() => {
        const imageBase = resolveImageBase(settings, base);
        return {
          count: Array.isArray(shareRecord.members) ? shareRecord.members.length : 0,
          members: Array.isArray(shareRecord.members) ? shareRecord.members.slice(0, 500) : [],
          url: imageBase ? imageBase + '/g/' + shareRecord.token : ('/g/' + shareRecord.token),
        };
      })() : null,
      items: Array.isArray(items) ? items.filter((item) => item != null).map((item) => ({ name: item.name, size: item.size, type: item.type })) : null,
      collection: !!shareRecord.collection,
      adminNote: shareRecord.adminNote || null,
      disabled: !!shareRecord.disabled,
      revoked: !!shareRecord.revoked,
      active,
      scheduled: shareService.isScheduled(shareRecord),
      hasPassword: !!shareRecord.pwHash,
      pwHint: shareRecord.pwHash ? (shareRecord.pwHint || '') : '',
      maxDownloadsPerIp: Math.max(0, Number(shareRecord.maxDownloadsPerIp) || 0),
      emoji: shareRecord.emoji || '',
      maxBytesServed: Math.max(0, Number(shareRecord.maxBytesServed) || 0),
      bytesServed: Math.max(0, Number(shareRecord.bytesServed) || 0),
      encrypted: !!shareRecord.encrypted,
      encMode: shareRecord.encrypted ? (shareRecord.encMode || 'key') : null,
      allowZip: shareRecord.allowZip !== false,
      noPreview: !!shareRecord.noPreview,
      burnAfterDownload: !!shareRecord.burnAfterDownload,
      burnedAt: shareRecord.burnedAt || null,
      tags: Array.isArray(shareRecord.tags) ? shareRecord.tags : [],
      geoMode: shareRecord.geoMode || null,
      geoCountries: Array.isArray(shareRecord.geoCountries) ? shareRecord.geoCountries : [],
      ipMode: shareRecord.ipMode || null,
      ipList: Array.isArray(shareRecord.ipList) ? shareRecord.ipList : [],
      ownerId: shareRecord.ownerId || null,
      ownerName: shareRecord.ownerName || null,
      note: shareRecord.note || '',
      rateKBps: shareRecord.rateBps > 0 ? Math.round(shareRecord.rateBps / 1024) : 0,
      path: rel,
      url: base ? base + rel : null,
      inbox: shareRecord.type === 'inbox' ? (() => {
        const pwaDeviceService = requiredService(getPwaDeviceService, 'pwa-device-service');
        return {
          maxFiles: shareRecord.maxFiles || 0,
          maxFileBytes: shareRecord.maxFileBytes || 0,
          maxTotalBytes: shareRecord.maxTotalBytes || 0,
          bytesReceived: shareRecord.bytesReceived || 0,
          allowExt: Array.isArray(shareRecord.allowExt) ? shareRecord.allowExt : [],
          blockExt: Array.isArray(shareRecord.blockExt) ? shareRecord.blockExt : [],
          note: shareRecord.note || '',
          messages: Array.isArray(shareRecord.messages) ? shareRecord.messages : [],
          groupBySender: !!shareRecord.groupBySender,
          tagBySender: !!shareRecord.tagBySender,
          rejectDuplicates: !!shareRecord.rejectDuplicates,
          requireSenderName: !!shareRecord.requireSenderName,
          blockExecutables: !!shareRecord.blockExecutables,
          maxFilesPerSender: shareRecord.maxFilesPerSender || 0,
          maxBytesPerSender: shareRecord.maxBytesPerSender || 0,
          maxFilesPerUpload: shareRecord.maxFilesPerUpload || 0,
          moderated: !!shareRecord.moderated,
          encrypted: !!shareRecord.encrypted,
          encMode: shareRecord.encrypted ? (shareRecord.encMode || 'key') : null,
          deviceName: pwaDeviceService.shareCreatorDeviceName(shareRecord),
        };
      })() : undefined,
      collab: shareRecord.type === 'collab' ? {
        relDir: shareRecord.relDir,
        allowDelete: !!shareRecord.allowDelete,
        allowZip: shareRecord.allowZip !== false,
        maxFileBytes: shareRecord.maxFileBytes || 0,
        maxTotalBytes: shareRecord.maxTotalBytes || 0,
        maxFiles: shareRecord.maxFiles || 0,
        maxFilesPerUpload: shareRecord.maxFilesPerUpload || 0,
        bytesReceived: shareRecord.bytesReceived || 0,
        allowExt: Array.isArray(shareRecord.allowExt) ? shareRecord.allowExt : [],
        blockExt: Array.isArray(shareRecord.blockExt) ? shareRecord.blockExt : [],
        note: shareRecord.note || '',
        blockExecutables: !!shareRecord.blockExecutables,
        groupBySender: !!shareRecord.groupBySender,
        tagBySender: !!shareRecord.tagBySender,
        rejectDuplicates: !!shareRecord.rejectDuplicates,
        requireSenderName: !!shareRecord.requireSenderName,
        maxFilesPerSender: shareRecord.maxFilesPerSender || 0,
        maxBytesPerSender: shareRecord.maxBytesPerSender || 0,
        moderated: !!shareRecord.moderated,
      } : undefined,
      pending: (() => {
        const indexed = context && context.pendingByShareId && typeof context.pendingByShareId.get === 'function'
          ? context.pendingByShareId.get(shareRecord.id)
          : null;
        const meta = state && state.meta && typeof state.meta === 'object' ? state.meta : null;
        const rows = Array.isArray(indexed)
          ? indexed
          : (meta && Array.isArray(meta.pending) ? meta.pending.filter((row) => row && row.shareId === shareRecord.id) : []);
        return rows.filter((row) => row != null).map((row) => ({ id: row.id, name: row.name, size: row.size, ip: row.ip, at: row.at }));
      })(),
      recipients: Array.isArray(shareRecord.recipients) ? shareRecord.recipients.filter((recipient) => recipient != null).map((recipient) => ({
        token: recipient.token,
        name: recipient.name,
        createdAt: recipient.createdAt || null,
        path: '/s/' + recipient.token,
        url: base ? base + '/s/' + recipient.token : null,
        downloads: recipient.stats && recipient.stats.completed || 0,
        stats: recipient.stats || null,
        expiresAt: recipient.expiresAt || null,
        maxDownloads: recipient.maxDownloads || null,
        viewed: !!recipient.viewedAt,
        viewedAt: recipient.viewedAt || null,
        lastViewAt: recipient.lastViewAt || null,
        lastViewIp: recipient.lastViewIp ? pubIp(recipient.lastViewIp) : null,
        lastViewCountry: recipient.lastViewCountry || null,
        lastDownloadAt: recipient.stats && recipient.stats.lastAt || null,
      })) : [],
      stats: shareService.displayStatsForShare(shareRecord),
    };
  }

  function externalTarget(req, baseOverride) {
    const rawOverride = String(baseOverride == null ? '' : baseOverride).trim();
    const settingsBase = normalizeLinkBase(currentSettings().linkBase) || '';
    const proxyOrigin = trustedProxyOrigin(req);
    const explicit = rawOverride
      ? normalizeLinkBase(rawOverride)
      : (settingsBase || PUBLIC_URL || proxyOrigin || '');
    // An explicitly supplied invalid base must not silently test a different
    // configured/public host; callers can report the target as invalid instead.
    if (rawOverride && !explicit) return null;
    if (explicit) {
      try {
        const url = new URL(explicit.includes('://') ? explicit : `http://${explicit}`);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
        if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
        return { host: url.hostname, port, label: `${url.protocol}//${url.host}` };
      } catch (_) {}
    }
    return null;
  }

  return {
    externalProto,
    hostIsIpLiteral,
    normalizeLinkBase,
    primaryBase,
    decorateShare,
    externalTarget,
  };
}

module.exports = {
  createSharePresentationService,
  externalProto,
  hostIsIpLiteral,
  normalizeLinkBase,
};
