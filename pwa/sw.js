'use strict';
/* Direct-Xfer PWA service worker.
 * Shell versioning + network-aware updates. Upload/API requests are never cached.
 * Web Share Target batches are isolated so simultaneous shares cannot overwrite one another.
 */
var VERSION = '2026.08.18-pwa343';
var SHELL_CACHE = 'dx-pwa-shell-' + VERSION;
var RUNTIME_CACHE = 'dx-pwa-runtime-' + VERSION;
var SHARE_CACHE = 'dx-share-v2';
// The ?v=<build> query on the JS/CSS assets MUST match what index.html requests, so a
// freshly-served index.html resolves its shell to this version's assets (never a stale
// cross-version mix). Bump ?v here and in index.html together on every release.
var SHELL = [
  '/app/launch',
  '/direct-xfer-pwa-shell.html',
  '/app/app.css?v=343',
  '/app/theme-init.js?v=343',
  '/app/admin-advanced.js?v=343',
  '/app/admin-audit-connectors.js?v=343',
  '/server-health-dashboard.css?v=343',
  '/server-health-dashboard.js?v=343',
  '/app/login-vault.js?v=269',
  '/app/dlp-local.js?v=270',
  '/download-resume.js?v=269',
  '/app/app.js?v=343',
  '/app/mobile-intelligence.js?v=343',
  '/direct-xfer-pwa.webmanifest',
  '/direct-xfer-pwa-en.webmanifest',
  '/direct-xfer-pwa-es.webmanifest',
  '/app/icon.svg',
  '/app/icon-maskable.svg',
  '/app/icon-192.png',
  '/app/icon-512.png',
  '/app/icon-maskable-192.png',
  '/app/icon-maskable-512.png',
  '/app/apple-touch-icon.png',
  '/ui/notification-volume-on.svg',
  '/ui/notification-volume-off.svg',
  '/ui/notification-settings.svg',
  '/dxcrypto.js?v=269'
];

function randomId() {
  var a = new Uint8Array(18); self.crypto.getRandomValues(a);
  return Array.prototype.map.call(a, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
}

// Only static shell assets may be cached. Dynamic /app/ endpoints (device status,
// image/inbox/share mutations, uploads…) must ALWAYS hit the network: a cached
// /app/device/status would replay a stale CSRF token and 403 every mutation
// (e.g. "could not create the link"). Allowlist by shell membership or extension.
function isStaticAsset(pathname) {
  return SHELL.indexOf(pathname) !== -1 || /\.(css|m?js|wasm|gz|png|jpe?g|svg|webp|gif|ico|webmanifest|woff2?)$/.test(pathname);
}

self.addEventListener('install', function (event) {
  var upgrading = !!self.registration.active;
  event.waitUntil(caches.open(SHELL_CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () {
    // On the FIRST install there is no older active worker. Do not show the
    // "new version available" banner merely because the PWA was installed.
    if (!upgrading) return [];
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then(function (clients) {
    (clients || []).forEach(function (client) { client.postMessage({ type: 'UPDATE_READY', version: VERSION }); });
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      if (key === SHELL_CACHE || key === RUNTIME_CACHE || key === SHARE_CACHE) return false;
      return key.indexOf('dx-pwa-shell-') === 0 || key.indexOf('dx-pwa-runtime-') === 0 || key.indexOf('dx-share-') === 0;
    }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return caches.open(SHARE_CACHE); })
    .then(function (cache) { return cleanupOldShareBatches(cache); })
    .then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'PURGE_PRIVATE_DATA') {
    event.waitUntil(Promise.all([
      caches.delete(SHARE_CACHE),
      caches.delete(RUNTIME_CACHE),
      caches.open(SHELL_CACHE).then(function (cache) { return cache.delete('/app/'); })
    ]));
  }
  // The page tells the SW its language so the closed-app resume prompt is localized.
  if (event.data && event.data.type === 'SET_LANG' && event.data.lang) {
    event.waitUntil(caches.open(RUNTIME_CACHE).then(function (cache) {
      return cache.put('/app/__lang', new Response(String(event.data.lang).slice(0, 5)));
    }).catch(function () {}));
  }
  if (event.data && event.data.type === 'TRANSFER_PROGRESS') event.waitUntil(showActiveTransferNotification(event.data));
  if (event.data && event.data.type === 'TRANSFER_PROGRESS_CLEAR') event.waitUntil(clearActiveTransferNotification());
});

function swFmtBytes(bytes, language) {
  var n=Math.max(0,Number(bytes)||0),units=String(language||'').slice(0,2)==='fr'?['o','Ko','Mo','Go','To']:['B','KB','MB','GB','TB'],i=0;
  while(n>=1024&&i<units.length-1){n/=1024;i++;}
  return (i?n.toFixed(n>=10?1:2):Math.round(n))+' '+units[i];
}
function swFmtEta(seconds) {
  seconds=Math.max(0,Math.ceil(Number(seconds)||0));var h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),sec=seconds%60;
  return (h?h+'h ':'')+(m?m+'m ':'')+sec+'s';
}
async function clearActiveTransferNotification() {
  if (!self.registration.getNotifications) return;
  try { var rows=await self.registration.getNotifications({tag:'dx-transfer-active'}); (rows||[]).forEach(function(n){try{n.close();}catch(_){}}); } catch (_) {}
}
async function showActiveTransferNotification(data) {
  data=data||{};var chosen=String(data.lang||'').slice(0,2);if(!RESUME_PROMPT[chosen])chosen=await swLang();var dict=RESUME_PROMPT[chosen]||RESUME_PROMPT.fr;
  var total=Math.max(0,Number(data.total)||0),sent=Math.max(0,Math.min(total||Number.MAX_SAFE_INTEGER,Number(data.sent)||0));
  var pct=total>0?Math.max(0,Math.min(100,Math.round((sent/total)*100))):Math.max(0,Math.min(100,Number(data.percent)||0));
  var body=(data.paused?'⏸ ':'')+pct+'% · '+swFmtBytes(sent,chosen)+(total?' / '+swFmtBytes(total,chosen):'');
  if(Number(data.rate)>0&&!data.paused)body+=' · ↑ '+swFmtBytes(data.rate,chosen)+'/s';
  if(Number(data.etaSeconds)>0&&!data.paused)body+=' · ETA '+swFmtEta(data.etaSeconds);
  if(Number(data.done)>=0&&Number(data.count)>0)body+=' · '+Number(data.done)+'/'+Number(data.count);
  return self.registration.showNotification(dict.transferTitle || 'Direct-Xfer', {
    body:body, icon:'/app/icon-192.png', badge:'/app/icon-192.png', tag:'dx-transfer-active', renotify:false, silent:true, requireInteraction:true,
    data:{kind:'upload-progress',url:'/app/?action=send'}
  });
}

// Background/Periodic Sync. The page performs every security-sensitive
// step first (DLP decision, image transformation and optional encryption), persists
// the resulting upload bytes, then marks the queue record `backgroundReady`. The
// worker only transports those already-approved bytes; it never owns a passphrase,
// encryption key or a way to bypass the DLP gate.
var BG_DB_NAME = 'direct-xfer-pwa';
var BG_DB_VERSION = 7;
var BG_QUEUE_STORE = 'queue';
var BG_META_STORE = 'meta';
var BG_OPFS_DIR = 'durable-transfers-v1';
var BG_CHUNK = 768 * 1024;
var BG_TIMEOUT_MS = 4 * 60 * 1000;
var RESUME_PROMPT = {
  fr: { body: 'Des transferts sont en attente.', complete: '{n} transfert(s) terminé(s) en arrière-plan.', failed: '{n} transfert(s) nécessite(nt) votre attention.', transferTitle: 'Direct-Xfer · Transfert' },
  en: { body: 'Transfers are waiting.', complete: '{n} transfer(s) completed in the background.', failed: '{n} transfer(s) need your attention.', transferTitle: 'Direct-Xfer · Transfer' },
  es: { body: 'Hay transferencias en espera.', complete: '{n} transferencia(s) completada(s) en segundo plano.', failed: '{n} transferencia(s) requiere(n) atención.', transferTitle: 'Direct-Xfer · Transferencia' }
};
function swLang() {
  return caches.open(RUNTIME_CACHE)
    .then(function (cache) { return cache.match('/app/__lang'); })
    .then(function (res) { return res ? res.text() : ''; })
    .then(function (lang) { return RESUME_PROMPT[String(lang || '').slice(0, 2)] ? String(lang).slice(0, 2) : 'fr'; })
    .catch(function () { return 'fr'; });
}
function bgOpenDb() {
  return new Promise(function (resolve, reject) {
    if (!self.indexedDB) return reject(new Error('idb-unavailable'));
    var request, settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; reject(new Error('idb-timeout')); } }, 5000);
    try { request = self.indexedDB.open(BG_DB_NAME, BG_DB_VERSION); }
    catch (e) { clearTimeout(timer); return reject(e); }
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains(BG_QUEUE_STORE)) db.createObjectStore(BG_QUEUE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BG_META_STORE)) db.createObjectStore(BG_META_STORE, { keyPath: 'key' });
    };
    request.onsuccess = function () { if (!settled) { settled = true; clearTimeout(timer); resolve(request.result); } };
    request.onerror = function () { if (!settled) { settled = true; clearTimeout(timer); reject(request.error || new Error('idb-error')); } };
    request.onblocked = function () { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('idb-blocked')); } };
  });
}
function bgDbAction(db, mode, fn, storeName) {
  return new Promise(function (resolve, reject) {
    storeName = storeName || BG_QUEUE_STORE;
    var tx = db.transaction(storeName, mode), store = tx.objectStore(storeName), value;
    try { value = fn(store); } catch (e) { return reject(e); }
    tx.oncomplete = function () { resolve(value); };
    tx.onerror = function () { reject(tx.error || new Error('idb-error')); };
    tx.onabort = function () { reject(tx.error || new Error('idb-abort')); };
  });
}
function bgQueueAll(db) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(BG_QUEUE_STORE, 'readonly'), request = tx.objectStore(BG_QUEUE_STORE).getAll();
    request.onsuccess = function () { resolve(request.result || []); };
    request.onerror = function () { reject(request.error || new Error('idb-read')); };
  });
}
function bgQueuePut(db, record) { return bgDbAction(db, 'readwrite', function (store) { store.put(record); }); }
function bgMetaGet(db, key, fallback) {
  return new Promise(function (resolve) {
    if (!db.objectStoreNames.contains(BG_META_STORE)) return resolve(fallback);
    var tx, request;
    try { tx=db.transaction(BG_META_STORE,'readonly'); request=tx.objectStore(BG_META_STORE).get(key); }
    catch (_) { return resolve(fallback); }
    request.onsuccess=function(){var row=request.result;resolve(row&&row.value!==undefined?row.value:fallback);};
    request.onerror=function(){resolve(fallback);};
    tx.onabort=function(){resolve(fallback);};
  });
}
function bgWifiAllowed(record) {
  if (!record || !record.wifiRequired) return true;
  var c=self.navigator&&(self.navigator.connection||self.navigator.mozConnection||self.navigator.webkitConnection);
  if (!c || !c.type) return false; // fail closed in background; the foreground can explain/override unknown APIs
  var type=String(c.type).toLowerCase();
  return type==='wifi'||type==='ethernet'||type==='wimax';
}
async function bgReadOpfs(path, type) {
  if (!path || !self.navigator || !self.navigator.storage || typeof self.navigator.storage.getDirectory !== 'function') return null;
  var root = await self.navigator.storage.getDirectory();
  var dir = await root.getDirectoryHandle(BG_OPFS_DIR, { create: false });
  var handle = await dir.getFileHandle(path, { create: false });
  var file = await handle.getFile();
  return type && file.type !== type ? file.slice(0, file.size, type) : file;
}
async function bgDeleteOpfs(path) {
  if (!path || !self.navigator || !self.navigator.storage || typeof self.navigator.storage.getDirectory !== 'function') return;
  try {
    var root = await self.navigator.storage.getDirectory();
    var dir = await root.getDirectoryHandle(BG_OPFS_DIR, { create: false });
    await dir.removeEntry(path);
  } catch (_) {}
}
async function bgPreparedBlob(record) {
  if (record.preparedBlob) return record.preparedBlob;
  if (record.preparedOpfsPath) return bgReadOpfs(record.preparedOpfsPath, record.preparedType || 'application/octet-stream');
  if (record.preparedUsesSource) {
    if (record.file) return record.file;
    if (record.opfsPath) return bgReadOpfs(record.opfsPath, record.preparedType || record.type || 'application/octet-stream');
  }
  return null;
}
function bgFetch(url, options, timeoutMs) {
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || BG_TIMEOUT_MS) : null;
  options = options || {};
  if (controller) options.signal = controller.signal;
  return fetch(url, options).finally(function () { if (timer) clearTimeout(timer); });
}
function bgUploadUrl(record, offset) {
  var snap = record.snapshot || {};
  var qs = '?path=' + encodeURIComponent(record.upName) + '&id=' + encodeURIComponent(record.uploadId) + '&size=' + Number(record.upSize) + '&offset=' + Number(offset || 0);
  if (snap.sender) qs += '&sender=' + encodeURIComponent(snap.sender);
  if (snap.expire) qs += '&expire=' + encodeURIComponent(snap.expire);
  if (record.contentHash) qs += '&sha256=' + encodeURIComponent(record.contentHash);
  return '/u/' + encodeURIComponent(snap.token) + '/upload' + qs;
}
function bgFatalStatus(status) { return [400, 401, 403, 404, 410, 413, 415, 422].indexOf(Number(status)) !== -1; }
async function bgMarkFatal(db, record, code) {
  record.state = 'error'; record.errorCode = code || 'background-upload'; record.backgroundReady = false; record.resumeOnOpen = false;
  record.backgroundFailedAt = Date.now(); record.lastCheckpointAt=Date.now(); record.recoveryReason=code || 'background-upload'; record.recoveryAttempts=Math.max(0,Number(record.recoveryAttempts)||0)+1;
  await bgQueuePut(db, record);
  return { failed: true };
}
async function bgMarkComplete(db, record, response) {
  var sourcePath = record.opfsPath || null, preparedPath = record.preparedOpfsPath || null;
  record.state = 'done-background'; record.sentBytes = Number(record.upSize) || 0; record.resumeOnOpen = false; record.backgroundReady = false;
  record.backgroundCompletedAt = Date.now(); record.lastCheckpointAt=Date.now(); record.recoveredAt=Date.now(); record.recoveryReason='background-complete'; record.backgroundResponse = response && typeof response === 'object' ? response : null;
  record.file = null; record.preparedBlob = null; record.opfsPath = null; record.preparedOpfsPath = null; record.preparedUsesSource = false;
  await bgQueuePut(db, record);
  await Promise.all([bgDeleteOpfs(sourcePath), preparedPath && preparedPath !== sourcePath ? bgDeleteOpfs(preparedPath) : Promise.resolve()]);
  return { completed: true };
}
async function bgUploadOne(db, record, notifyProgress, notifyLang, aggregate) {
  var snap = record && record.snapshot || {};
  async function notifyOffset(offset) {
    if (!notifyProgress) return;
    var base=aggregate?Math.max(0,Number(aggregate.base)||0):0,total=aggregate?Math.max(0,Number(aggregate.total)||0):uploadSize;
    var sent=base+Math.max(0,Number(offset)||0),count=aggregate?Math.max(1,Number(aggregate.count)||1):1,done=aggregate?Math.max(0,Number(aggregate.done)||0):0;
    try { await showActiveTransferNotification({sent:sent,total:total,percent:total?Math.round(sent/total*100):0,done:done,count:count,lang:notifyLang}); } catch (_) {}
  }
  var uploadSize = Number(record && record.upSize);
  if (!record || record.backgroundReady !== true || !record.resumeOnOpen || !snap.token || !record.uploadId || !record.upName || !Number.isFinite(uploadSize) || uploadSize < 0) return { skipped: true };
  var blob;
  try { blob = await bgPreparedBlob(record); }
  catch (_) { return bgMarkFatal(db, record, 'background-payload-missing'); }
  if (!blob || Number(blob.size) !== uploadSize) return bgMarkFatal(db, record, 'background-payload-missing');
  var statusUrl = '/u/' + encodeURIComponent(snap.token) + '/upload-status?id=' + encodeURIComponent(record.uploadId);
  var statusResponse;
  try { statusResponse = await bgFetch(statusUrl, { credentials: 'include', cache: 'no-store' }, 20000); }
  catch (_) { throw new Error('background-network'); }
  if (!statusResponse.ok) {
    if (bgFatalStatus(statusResponse.status)) return bgMarkFatal(db, record, statusResponse.status === 401 ? 'locked' : 'revoked');
    throw new Error('background-status-' + statusResponse.status);
  }
  var statusBody = await statusResponse.json().catch(function () { return {}; });
  // The server remembers recently-completed upload ids. This closes the classic
  // lost-final-response hole: once the destination file has been committed, a
  // retry must acknowledge it instead of starting the same file again at offset 0.
  if (statusBody.complete === true) return bgMarkComplete(db, record, statusBody.response || { ok: true, complete: true });
  var offset = Math.min(uploadSize, Math.max(0, Number(statusBody.offset) || 0));
  await notifyOffset(offset);
  var failures = 0;
  while (offset < uploadSize) {
    // Re-evaluate the transport before every block. If Android roams from Wi-Fi
    // to cellular while the PWA is closed, stop after the current completed block
    // instead of finishing the rest of a large Wi-Fi-only file on mobile data.
    if (!bgWifiAllowed(record)) throw new Error('background-wifi-required');
    var end = Math.min(uploadSize, offset + BG_CHUNK), response;
    try {
      response = await bgFetch(bgUploadUrl(record, offset), {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
        body: blob.slice(offset, end)
      }, BG_TIMEOUT_MS);
    } catch (_) {
      failures++;
      if (failures >= 3) throw new Error('background-network');
      continue;
    }
    var body = await response.clone().json().catch(function () { return {}; });
    if (response.ok) return bgMarkComplete(db, record, body);
    if (response.status === 409 && Number(body.offset) >= 0) {
      var next = Math.min(uploadSize, Math.max(0, Number(body.offset)));
      if (next > offset) { offset = next; failures = 0; record.sentBytes = offset; record.lastServerOffset=offset; record.lastCheckpointAt=Date.now(); await bgQueuePut(db, record); await notifyOffset(offset); continue; }
      failures++;
      if (failures >= 3) throw new Error('background-busy');
      continue;
    }
    if (response.status === 429 || response.status >= 500) throw new Error('background-retry-' + response.status);
    if (bgFatalStatus(response.status)) return bgMarkFatal(db, record, String(body.error || ('http-' + response.status)));
    throw new Error('background-http-' + response.status);
  }
  // A lost final response can leave the .part at exactly total bytes. The server's
  // resumable endpoint deliberately finalizes that state when it receives one more
  // request at offset=total, so send an empty, idempotent finalize request.
  var finalResponse;
  try {
    finalResponse = await bgFetch(bgUploadUrl(record, uploadSize), {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      body: blob.slice(uploadSize, uploadSize)
    }, BG_TIMEOUT_MS);
  } catch (_) { throw new Error('background-finalize-network'); }
  var finalBody = await finalResponse.clone().json().catch(function () { return {}; });
  if (finalResponse.ok) return bgMarkComplete(db, record, finalBody);
  if (bgFatalStatus(finalResponse.status)) return bgMarkFatal(db, record, String(finalBody.error || ('http-' + finalResponse.status)));
  throw new Error('background-finalize-' + finalResponse.status);
}
async function runBackgroundUploads() {
  var db = await bgOpenDb(), records;
  try { records = await bgQueueAll(db); }
  catch (e) { try { db.close(); } catch (_) {} throw e; }
  var eligible = records.filter(function (r) { return r && r.backgroundReady === true && r.resumeOnOpen && ['waiting', 'waiting-network', 'sending'].indexOf(r.state) !== -1; });
  var transportable = eligible.filter(bgWifiAllowed);
  var completed = 0, failed = 0, retry = transportable.length !== eligible.length, completedBytes = 0;
  var notifyProgress = (await bgMetaGet(db, 'transferNotificationEnabled', true)) !== false;
  var notifyLang = await swLang();
  // A Wi-Fi-blocked record is pending but is not part of the currently moving
  // progress denominator; otherwise a small allowed file could appear permanently
  // stuck at 1% because a 100 GiB Wi-Fi-only file is waiting beside it.
  var aggregateTotal=transportable.reduce(function(sum,r){return sum+Math.max(0,Number(r&&r.upSize)||0);},0);
  var aggregate={base:0,total:aggregateTotal,count:transportable.length,done:0};
  for (var i = 0; i < transportable.length; i++) {
    aggregate.base=completedBytes;aggregate.done=completed;
    try {
      var result = await bgUploadOne(db, transportable[i], notifyProgress, notifyLang, aggregate);
      if (result.completed) {
        completed++; completedBytes += Math.max(0,Number(transportable[i].upSize)||0); aggregate.base=completedBytes; aggregate.done=completed;
        if(notifyProgress) try { await showActiveTransferNotification({sent:completedBytes,total:aggregateTotal,done:completed,count:transportable.length,lang:notifyLang}); } catch (_) {}
      }
      else if (result.failed) failed++;
    } catch (_) { retry = true; }
  }
  try { db.close(); } catch (_) {}
  await clearActiveTransferNotification();
  return { completed: completed, failed: failed, retry: retry, pending: eligible.length };
}
function notifyBackgroundResult(result) {
  if (!result || (!result.completed && !result.failed)) return Promise.resolve();
  return swLang().then(function (lang) {
    var dict = RESUME_PROMPT[lang], parts = [];
    if (result.completed) parts.push(dict.complete.replace('{n}', String(result.completed)));
    if (result.failed) parts.push(dict.failed.replace('{n}', String(result.failed)));
    return self.registration.showNotification('Direct-Xfer', {
      body: parts.join(' '),
      icon: '/app/icon-192.png', badge: '/app/icon-192.png',
      tag: result.completed && result.failed ? 'dx-background-mixed' : result.completed ? 'dx-background-complete' : 'dx-background-failed', renotify: true,
      data: { kind: 'upload-complete', url: '/app/?action=send' }
    });
  });
}
function resumePendingUploads(reason) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async function (clients) {
    // A visible page owns its active queue. A hidden/frozen Android client, however,
    // cannot be relied upon to process postMessage; treating it as active consumed the
    // sync event without moving a byte. Unknown visibility is kept on the conservative
    // page-owned path for compatibility with older WindowClient implementations.
    var visibleClients = (clients || []).filter(function (client) {
      return !client || typeof client.visibilityState !== 'string' || client.visibilityState === 'visible';
    });
    if (visibleClients.length) {
      visibleClients.forEach(function (client) { try { client.postMessage({ type: 'RESUME_TRANSFERS', reason: reason || 'background-sync' }); } catch (_) {} });
      return { delegated: true };
    }
    var result;
    try { result = await runBackgroundUploads(); }
    catch (_) { result = { completed: 0, failed: 0, retry: true, pending: 0 }; }
    await notifyBackgroundResult(result);
    // Rejecting the one-shot sync asks supporting browsers to retry it later. A
    // registered Periodic Sync remains an additional recovery path.
    if (result.retry) throw new Error('background-retry');
    if (!result.pending) return result;
    return result;
  });
}
self.addEventListener('sync', function (event) {
  if (event.tag === 'dx-resume-uploads') event.waitUntil(resumePendingUploads('background-sync'));
});
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'dx-periodic-uploads') event.waitUntil(resumePendingUploads('periodic-sync'));
});

// Web Push: a file landed on an inbox this device owns. Show a notification even
// when the app is closed. The payload is a small JSON built server-side.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text ? event.data.text() : '' }; }
  var title = data.title || 'Direct-Xfer';
  var body = data.body || '';
  var receivedAt = Date.now();
  var notify = self.registration.showNotification(title, {
    body: body,
    icon: '/app/icon-192.png',
    badge: '/app/icon-192.png',
    tag: data && data.kind === 'image-first-view' ? ('dx-image-first-view-' + (data.token || 'image')) : (data && data.kind === 'test' ? ('dx-push-test-' + (data.testId || 'test')) : 'dx-inbox'),
    renotify: true,
    data: { url: (data && data.url) || '/app/', kind: data.kind || '', token: data.token || '', testId: data.testId || '', destinationUrl: data.destinationUrl || '', openCenter: !!(data && data.openCenter), panel: (data && data.panel) || '', receivedAt: receivedAt, sentAt: Number(data && data.ts) || 0 }
  });
  // While the PWA is open, report the real service-worker receipt back to the
  // diagnostics button. This distinguishes “push service accepted it” from
  // “Android actually delivered it to this installation”.
  var report = data && data.testId ? self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) { try { client.postMessage({ type: 'PUSH_RECEIVED', testId: data.testId, receivedAt: receivedAt, sentAt: Number(data.ts) || 0, swVersion: VERSION }); } catch (_) {} });
  }) : Promise.resolve();
  event.waitUntil(Promise.all([notify, report]));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var action = event.action || 'open';
  var url = data.url || '/app/';
  try { var parsed = new URL(url, self.location.origin); url = parsed.origin === self.location.origin ? parsed.href : (self.location.origin + '/app/'); }
  catch (_) { url = self.location.origin + '/app/'; }
  if (data.kind === 'upload-complete') {
    if (action === 'copy-link') url = '/app/?action=copy-link&dest=' + encodeURIComponent(data.destinationUrl || '');
    else if (action === 'resend-last') url = '/app/?action=resend-last';
    else url = '/app/?action=send';
  } else if (data.openCenter) {
    // A cold start lands on the panel and opens the notification center.
    url = '/app/?opencenter=1' + (data.panel ? ('&panel=' + encodeURIComponent(data.panel)) : '');
  }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      if (clients[i].url.indexOf('/app') !== -1 && 'focus' in clients[i]) {
        var client = clients[i];
        if (data.kind === 'upload-complete' && client.postMessage) {
          return client.focus().then(function () { client.postMessage({ type: 'NOTIFICATION_ACTION', action: action, destinationUrl: data.destinationUrl || '' }); });
        }
        if (data.openCenter && client.postMessage) {
          return client.focus().then(function () { client.postMessage({ type: 'OPEN_NOTIFICATION_CENTER', panel: data.panel || '' }); });
        }
        // A generic Push may target a specific in-app URL/hash. Focusing an existing
        // window without navigating used to make notification taps appear to do nothing.
        if ('navigate' in client) {
          return client.navigate(url).then(function (navigated) { return navigated && navigated.focus ? navigated.focus() : client.focus(); }).catch(function () { return client.focus(); });
        }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

async function deleteShareBatch(cache, batch) {
  if (!batch) return;
  var prefix = '/app/__shared/' + batch + '/';
  var all = await cache.keys();
  await Promise.all(all.filter(function (request) { return new URL(request.url).pathname.indexOf(prefix) === 0; }).map(function (request) { return cache.delete(request); }));
}
async function cleanupOldShareBatches(cache) {
  var keys = await cache.keys();
  var now = Date.now();
  var batchRequests = Object.create(null);
  keys.forEach(function (request) {
    try {
      var match = new URL(request.url).pathname.match(/^\/app\/__shared\/([^/]+)\/(?:meta|file\/\d+)$/);
      if (match) {
        if (!batchRequests[match[1]]) batchRequests[match[1]] = { meta: null };
        if (/\/meta$/.test(new URL(request.url).pathname)) batchRequests[match[1]].meta = request;
      }
    } catch (_) {}
  });
  var batches = Object.keys(batchRequests);
  for (var i = 0; i < batches.length; i++) {
    var batch = batches[i], info = batchRequests[batch];
    // Old/interrupted versions could leave file entries without metadata. They can
    // never be recovered safely, so remove the whole orphan batch instead of letting
    // it consume CacheStorage indefinitely.
    if (!info.meta) { try { await deleteShareBatch(cache, batch); } catch (_) {} continue; }
    try {
      var response = await cache.match(info.meta);
      var meta = response ? await response.clone().json() : null;
      var stale = !meta || !meta.createdAt || now - meta.createdAt > 24 * 3600000;
      var abandoned = meta && meta.complete === false && now - meta.createdAt > 10 * 60000;
      if (stale || abandoned) await deleteShareBatch(cache, batch);
    } catch (_) {
      // Corrupt metadata is as unrecoverable as missing metadata.
      try { await deleteShareBatch(cache, batch); } catch (_) {}
    }
  }
}

async function handleShareTarget(request) {
  var batch = '';
  var cache = null;
  try {
    var form = await request.formData();
    var files = form.getAll('files').filter(function (file) { return file && typeof file.name === 'string'; });
    batch = randomId();
    cache = await caches.open(SHARE_CACHE);
    var meta = {
      id: batch,
      createdAt: Date.now(),
      complete: false,
      title: String(form.get('title') || '').slice(0, 1000),
      text: String(form.get('text') || '').slice(0, 100000),
      url: String(form.get('url') || '').slice(0, 8000),
      files: files.map(function (file, i) { return { name: file.name || ('file-' + (i + 1)), type: file.type || 'application/octet-stream', lastModified: file.lastModified || Date.now(), size: file.size || 0 }; })
    };
    // Write an incomplete marker FIRST. If Android kills the worker mid-copy, the
    // batch is discoverable and cleanup can remove it instead of leaking file blobs.
    await cache.put('/app/__shared/' + batch + '/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      await cache.put('/app/__shared/' + batch + '/file/' + i, new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }));
    }
    meta.complete = true;
    await cache.put('/app/__shared/' + batch + '/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    cleanupOldShareBatches(cache).catch(function () {});
    return Response.redirect('/app/?shared=' + encodeURIComponent(batch), 303);
  } catch (_) {
    if (cache && batch) { try { await deleteShareBatch(cache, batch); } catch (_) {} }
    return Response.redirect('/app/', 303);
  }
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);

  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/app/share-target') {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/app/') && url.pathname !== '/dxcrypto.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(function () {
      // Never cache authenticated /app/ HTML: it embeds an account-specific image
      // bootstrap. Offline mode uses the public raw shell and restores only local
      // IndexedDB/OPFS data. Authentication/login itself always requires the network.
      if (url.pathname === '/app/login') return new Response('Connexion administrateur indisponible hors ligne', { status: 503 });
      return caches.match('/direct-xfer-pwa-shell.html').then(function (hit) { return hit || new Response('Offline', { status: 503 }); });
    }));
    return;
  }

  // Never cache dynamic API responses — always go straight to the network.
  if (!isStaticAsset(url.pathname)) return;

  // Stale-while-revalidate for immutable-ish shell assets. The versioned cache
  // prevents old HTML and new JavaScript from being mixed after activation.
  event.respondWith(caches.match(request).then(function (cached) {
    var refresh = fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone(); caches.open(RUNTIME_CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () { return null; });
    if (cached) { event.waitUntil(refresh); return cached; }
    return refresh.then(function (response) { return response || new Response('Offline — resource unavailable', { status: 503 }); });
  }));
});
