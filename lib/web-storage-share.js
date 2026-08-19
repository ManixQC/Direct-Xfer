'use strict';

const crypto = require('crypto');
const { cleanRelativePath } = require('./storage-connectors');

function createWebStorageShareTools(options = {}) {
  const storageConnectorService = options.storageConnectorService;
  if (!storageConnectorService || typeof storageConnectorService.stat !== 'function' || typeof storageConnectorService.list !== 'function') {
    throw new TypeError('storageConnectorService is required');
  }
  const cacheMs = Math.min(60000, Math.max(1000, Number(options.cacheMs) || 15000));
  const statCache = new Map();

  function shareMeta(share) {
    const raw = share && ['web-storage','inbox','collab'].includes(share.type) && share.webStorage && typeof share.webStorage === 'object' ? share.webStorage : null;
    if (!raw) return null;
    const remote = String(raw.remote || '').trim();
    const root = cleanRelativePath(raw.root || '');
    const basePath = cleanRelativePath(raw.path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote) || root === null || basePath === null) return null;
    return {
      id:String(raw.connectorId || ''),
      name:String(raw.connectorName || '').slice(0,80),
      type:String(raw.connectorType || '').slice(0,40),
      remote:remote.slice(0,64),
      root,
      readOnly:!!raw.readOnly,
      path:basePath,
      isDir:!!raw.isDir,
      sourceId:raw.sourceId == null ? null : String(raw.sourceId).slice(0,300),
    };
  }

  function importMeta(share, connector) {
    const meta = shareMeta(share);
    if (!meta || !connector || String(connector.id || '') !== meta.id) return null;
    const remote = String(connector.remote || '').trim();
    const root = cleanRelativePath(connector.root || '');
    const type = String(connector.type || '').trim();
    if (remote !== meta.remote || root === null || root !== meta.root || type !== meta.type) return null;
    const raw = share && share.webStorage && typeof share.webStorage === 'object' ? share.webStorage : {};
    return { connectorId:meta.id, connectorName:String(connector.name || meta.name || '').slice(0,80), connectorType:type.slice(0,40), remote:remote.slice(0,64), root, readOnly:!!connector.readOnly, path:meta.path, isDir:meta.isDir, sourceId:meta.sourceId, sourceName:String(raw.sourceName || share.name || '').replace(/[\r\n\t]+/g,' ').trim().slice(0,255) };
  }

  function joinedPath(share, relative) {
    const meta = shareMeta(share);
    if (!meta) return null;
    const rel = cleanRelativePath(relative || '');
    if (rel === null) return null;
    return [meta.path, rel].filter(Boolean).join('/');
  }

  function relativePath(share, fullPath) {
    const meta = shareMeta(share);
    const full = cleanRelativePath(fullPath, false);
    if (!meta || full === null) return null;
    if (!meta.path) return full;
    if (full === meta.path) return '';
    const prefix = meta.path + '/';
    return full.startsWith(prefix) ? full.slice(prefix.length) : null;
  }

  function cacheIdentity(share, meta) {
    return [String(share && share.id || ''), meta.remote, meta.root, meta.path, meta.sourceId || ''].join('\0');
  }

  function cacheKey(share, meta, full) {
    return `${cacheIdentity(share, meta)}\0${full}`;
  }

  function invalidate(share, relative = '', recursive = false) {
    const meta = shareMeta(share);
    const full = joinedPath(share, relative);
    if (!meta || full === null) return 0;
    const identity = cacheIdentity(share, meta), prefix = identity + '\0';
    let removed = 0;
    for (const [key, row] of statCache) {
      if (!key.startsWith(prefix)) continue;
      const rowFull = String(row && row.full || '');
      if (rowFull === full || (recursive && rowFull.startsWith(full + '/'))) { statCache.delete(key); removed += 1; }
    }
    return removed;
  }

  async function stat(share, relative = '', statOptions = {}) {
    const meta = shareMeta(share);
    const full = joinedPath(share, relative);
    if (!meta || full === null) throw Object.assign(new Error('invalid-web-storage-share'), { code:'invalid-share' });
    const key = cacheKey(share, meta, full);
    const now = Date.now();
    const cached = statCache.get(key);
    if (!statOptions.fresh && cached && now - cached.at < cacheMs) return cached.value;
    let value;
    try { value = await storageConnectorService.stat(meta, full); }
    catch (error) {
      // A fresh negative lookup must also evict an older positive cache entry.
      // Otherwise a just-deleted/replaced cloud object can remain downloadable
      // with stale size/ETag metadata until the normal cache TTL expires.
      statCache.delete(key);
      throw error;
    }
    statCache.set(key, { at:now, value, full });
    if (statCache.size > 1000) {
      for (const [cacheKeyValue, row] of statCache) {
        if (now - Number(row && row.at || 0) > cacheMs * 4) statCache.delete(cacheKeyValue);
        if (statCache.size <= 800) break;
      }
    }
    return value;
  }

  async function list(share, relative = '') {
    const meta = shareMeta(share);
    const full = joinedPath(share, relative);
    if (!meta || full === null) throw Object.assign(new Error('invalid-web-storage-share'), { code:'invalid-share' });
    const rows = await storageConnectorService.list(meta, full);
    return rows.map((row) => {
      const rel = relativePath(share, row.path);
      if (rel === null) return null;
      return { name:row.name, rel, isDir:!!row.isDir, size:Math.max(0, Number(row.size) || 0), id:row.id || null };
    }).filter(Boolean);
  }

  async function walkFiles(share, options = {}) {
    const maxFiles = Math.min(20000, Math.max(1, Number(options.maxFiles) || 5000));
    const maxDirs = Math.min(5000, Math.max(1, Number(options.maxDirs) || 1000));
    const maxDepth = Math.min(64, Math.max(1, Number(options.maxDepth) || 24));
    const queue = [{ rel:'', depth:0 }], seen = new Set(['']);
    const files = [];
    let dirsVisited = 0, truncated = false;
    while (queue.length && files.length < maxFiles) {
      const current = queue.shift();
      if (++dirsVisited > maxDirs) { truncated = true; break; }
      const rows = await list(share, current.rel);
      for (const row of rows) {
        if (row.isDir) {
          if (current.depth >= maxDepth) { truncated = true; continue; }
          if (!seen.has(row.rel)) { seen.add(row.rel); queue.push({ rel:row.rel, depth:current.depth + 1 }); }
        } else {
          files.push(row);
          if (files.length >= maxFiles) { truncated = true; break; }
        }
      }
    }
    if (queue.length) truncated = true;
    return { files, truncated, dirsVisited };
  }

  function etag(share, statRow, relative) {
    const meta = shareMeta(share);
    if (!meta || !statRow) return null;
    // Provider IDs can survive in-place overwrites. Require a provider identity
    // and modification time before advertising a strong validator.
    const identity = String(statRow.id || meta.sourceId || '');
    const modTime = String(statRow.modTime || '').trim();
    if (!identity || !modTime) return null;
    const raw = [identity, String(statRow.size || 0), modTime, String(relative || ''), meta.remote, meta.root].join('\0');
    return `"dx-cloud-${crypto.createHash('sha256').update(raw).digest('base64url').slice(0,24)}"`;
  }

  function parseRange(req, total, etagValue) {
    let start = 0, end = Math.max(-1, total - 1), status = 200;
    const ifRange = String(req.headers['if-range'] || '').trim();
    const header = ifRange && (!etagValue || ifRange !== etagValue) ? null : req.headers.range;
    if (!header) return { start, end, status };
    const raw = String(header).trim();
    if (raw.includes(',')) return { error:'multi-range' };
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
    if (!match || (match[1] === '' && match[2] === '')) return { error:'invalid-range' };
    if (total <= 0) return { error:'unsatisfiable' };
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return { error:'unsatisfiable' };
      start = Math.max(0, total - suffix); end = total - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) return { error:'unsatisfiable' };
    }
    return { start, end, status:206 };
  }

  return { shareMeta, importMeta, joinedPath, relativePath, stat, list, walkFiles, invalidate, etag, parseRange };
}

module.exports = { createWebStorageShareTools };
