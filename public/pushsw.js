'use strict';
/* Direct-Xfer — admin Web Push service worker.
 * Push-only: it deliberately has NO `fetch` handler, so it never intercepts
 * requests and can't affect page loading or caching. It only shows notifications
 * pushed by the server (browser-notification channel) and handles clicks. */

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (_) { data = { body: e.data ? e.data.text() : '' }; }
  var title = data.title || 'Direct-Xfer';
  var opts = {
    body: data.body || '',
    icon: '/logo.svg',
    badge: '/logo.svg',
    tag: data.kind || 'dx',
    timestamp: data.ts || Date.now(),
    data: { url: data.url || '/' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          c.focus();
          if (url && 'navigate' in c) {
            // If in-place navigation fails (e.g. it rejects), fall back to a new window.
            return Promise.resolve(c.navigate(url)).catch(function () {
              if (self.clients.openWindow) return self.clients.openWindow(url);
            });
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
