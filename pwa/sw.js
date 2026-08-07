'use strict';
/* Direct-Xfer PWA service worker.
 * Shell versioning + network-aware updates. Upload/API requests are never cached.
 * Web Share Target batches are isolated so simultaneous shares cannot overwrite one another.
 */
var VERSION = '2026.08.04-pwa15';
var SHELL_CACHE = 'dx-pwa-shell-' + VERSION;
var RUNTIME_CACHE = 'dx-pwa-runtime-' + VERSION;
var SHARE_CACHE = 'dx-share-v2';
var SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.css',
  '/app/theme-init.js',
  '/app/app.js',
  '/app/manifest.webmanifest',
  '/app/manifest-en.webmanifest',
  '/app/manifest-es.webmanifest',
  '/app/icon.svg',
  '/app/icon-maskable.svg',
  '/app/icon-192.png',
  '/app/icon-512.png',
  '/app/icon-maskable-192.png',
  '/app/icon-maskable-512.png',
  '/app/apple-touch-icon.png',
  '/dxcrypto.js'
];

function randomId() {
  var a = new Uint8Array(18); self.crypto.getRandomValues(a);
  return Array.prototype.map.call(a, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(SHELL_CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then(function (clients) {
    clients.forEach(function (client) { client.postMessage({ type: 'UPDATE_READY', version: VERSION }); });
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key !== SHELL_CACHE && key !== RUNTIME_CACHE && key !== SHARE_CACHE && (key.indexOf('dx-pwa-shell-') === 0 || key.indexOf('dx-pwa-runtime-') === 0);
    }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function cleanupOldShareBatches(cache) {
  var keys = await cache.keys();
  var now = Date.now();
  var metas = keys.filter(function (request) { return /\/meta$/.test(new URL(request.url).pathname); });
  for (var i = 0; i < metas.length; i++) {
    try {
      var response = await cache.match(metas[i]);
      var meta = response ? await response.clone().json() : null;
      if (!meta || !meta.createdAt || now - meta.createdAt > 7 * 86400000) {
        var prefix = new URL(metas[i].url).pathname.replace(/\/meta$/, '/');
        var all = await cache.keys();
        await Promise.all(all.filter(function (request) { return new URL(request.url).pathname.indexOf(prefix) === 0; }).map(function (request) { return cache.delete(request); }));
      }
    } catch (_) {}
  }
}

async function handleShareTarget(request) {
  try {
    var form = await request.formData();
    var files = form.getAll('files').filter(function (file) { return file && typeof file.name === 'string'; });
    var batch = randomId();
    var cache = await caches.open(SHARE_CACHE);
    var meta = {
      id: batch,
      createdAt: Date.now(),
      title: String(form.get('title') || '').slice(0, 1000),
      text: String(form.get('text') || '').slice(0, 100000),
      url: String(form.get('url') || '').slice(0, 8000),
      files: []
    };
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      meta.files.push({ name: file.name || ('file-' + (i + 1)), type: file.type || 'application/octet-stream', lastModified: file.lastModified || Date.now(), size: file.size || 0 });
      await cache.put('/app/__shared/' + batch + '/file/' + i, new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }));
    }
    await cache.put('/app/__shared/' + batch + '/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    cleanupOldShareBatches(cache).catch(function () {});
    return Response.redirect('/app/?shared=' + encodeURIComponent(batch), 303);
  } catch (_) {
    return Response.redirect('/app/', 303);
  }
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);

  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/app/share') {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/app/') && url.pathname !== '/dxcrypto.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        var copy = response.clone(); caches.open(SHELL_CACHE).then(function (cache) { cache.put('/app/', copy); });
      }
      return response;
    }).catch(function () {
      return caches.match('/app/').then(function (hit) { return hit || new Response('Offline', { status: 503 }); });
    }));
    return;
  }

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
