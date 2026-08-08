'use strict';
/* Direct-Xfer PWA service worker.
 * Shell versioning + network-aware updates. Upload/API requests are never cached.
 * Web Share Target batches are isolated so simultaneous shares cannot overwrite one another.
 */
var VERSION = '2026.08.07-pwa123';
var SHELL_CACHE = 'dx-pwa-shell-' + VERSION;
var RUNTIME_CACHE = 'dx-pwa-runtime-' + VERSION;
var SHARE_CACHE = 'dx-share-v2';
// The ?v=<build> query on the JS/CSS assets MUST match what index.html requests, so a
// freshly-served index.html resolves its shell to this version's assets (never a stale
// cross-version mix). Bump ?v here and in index.html together on every release.
var SHELL = [
  '/app/launch',
  '/app/index.html',
  '/app/app.css?v=111',
  '/app/theme-init.js?v=111',
  '/app/login-vault.js?v=111',
  '/app/app.js?v=111',
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
  '/dxcrypto.js?v=111'
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
  return SHELL.indexOf(pathname) !== -1 || /\.(css|js|png|jpe?g|svg|webp|gif|ico|webmanifest|woff2?)$/.test(pathname);
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
});

// Web Push: a file landed on an inbox this device owns. Show a notification even
// when the app is closed. The payload is a small JSON built server-side.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text ? event.data.text() : '' }; }
  var title = data.title || 'Direct-Xfer';
  var body = data.body || '';
  event.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: '/app/icon-192.png',
    badge: '/app/icon-192.png',
    tag: data && data.kind === 'image-first-view' ? ('dx-image-first-view-' + (data.token || 'image')) : 'dx-inbox',
    renotify: true,
    data: { url: (data && data.url) || '/app/' }
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/app/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      if (clients[i].url.indexOf('/app') !== -1 && 'focus' in clients[i]) return clients[i].focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

async function cleanupOldShareBatches(cache) {
  var keys = await cache.keys();
  var now = Date.now();
  var metas = keys.filter(function (request) { return /\/meta$/.test(new URL(request.url).pathname); });
  for (var i = 0; i < metas.length; i++) {
    try {
      var response = await cache.match(metas[i]);
      var meta = response ? await response.clone().json() : null;
      if (!meta || !meta.createdAt || now - meta.createdAt > 24 * 3600000) {
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

  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/app/share-target') {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/app/') && url.pathname !== '/dxcrypto.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      var responsePath = response && response.url ? new URL(response.url).pathname : '';
      if (response && response.ok && response.type === 'basic' && !response.redirected && responsePath === '/app/') {
        var copy = response.clone(); caches.open(SHELL_CACHE).then(function (cache) { cache.put('/app/', copy); });
      }
      return response;
    }).catch(function () {
      // Never replace the administrator login with a previously cached app shell.
      // Authentication requires a live server connection.
      if (url.pathname === '/app/login') return new Response('Connexion administrateur indisponible hors ligne', { status: 503 });
      return caches.match('/app/').then(function (hit) { return hit || new Response('Offline', { status: 503 }); });
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
