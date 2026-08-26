'use strict';
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('dx-theme') || 'dark'; } catch (_) {}
  if (t !== 'light' && t !== 'auto' && t !== 'schedule') t = 'dark';
  var actual = t === 'schedule' ? ((new Date().getHours() >= 20 || new Date().getHours() < 7) ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', actual);
  document.documentElement.setAttribute('data-theme-mode', t);

  try {
    var ac = localStorage.getItem('dx-accent');
    if (ac && /^#[0-9a-fA-F]{6}$/.test(ac)) {
      document.documentElement.style.setProperty('--accent', ac);
      document.documentElement.style.setProperty('--accent-2', ac);
    }
  } catch (_) {}

  // 1.64.2: keep release metadata available before the large PWA bundle starts,
  // and layer the administrator-only health surface in an isolated module.
  var release = { version: '1.71.14', build: '2026.08.26-pwa477' };
  window.__DX_PWA_RELEASE = release;
  if (typeof window.fetch === 'function' && !window.__dxPwaReleaseFetchWrapped) {
    window.__dxPwaReleaseFetchWrapped = true;
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === 'string' && input.indexOf('/app/device/status?') !== -1) {
        try {
          var u = new URL(input, location.origin);
          if (u.origin === location.origin && u.pathname === '/app/device/status') {
            u.searchParams.set('version', release.version);
            u.searchParams.set('build', release.build);
            input = u.pathname + u.search + u.hash;
          }
        } catch (_) {}
      }
      return nativeFetch.call(this, input, init);
    };
  }
  if (!document.querySelector('script[data-dx-admin-advanced]')) {
    var adminScript = document.createElement('script');
    adminScript.src = '/app/admin-advanced.js?v=458';
    adminScript.async = true;
    adminScript.setAttribute('data-dx-admin-advanced', '1');
    document.head.appendChild(adminScript);
  }
  if (!document.querySelector('script[data-dx-admin-audit-connectors]')) {
    var auditConnectorScript = document.createElement('script');
    auditConnectorScript.src = '/app/admin-audit-connectors.js?v=458';
    auditConnectorScript.async = true;
    auditConnectorScript.setAttribute('data-dx-admin-audit-connectors', '1');
    document.head.appendChild(auditConnectorScript);
  }

  var lastHeight = 0;
  var frame = 0;
  function syncClientViewport() {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(function () {
      frame = 0;
      var viewport = window.visualViewport;
      var pinching = !!(viewport && Number(viewport.scale || 1) > 1.01);
      if (pinching) {
        document.documentElement.classList.add('dx-pinching');
        return;
      }
      document.documentElement.classList.remove('dx-pinching');
      var height = viewport && viewport.height ? viewport.height : window.innerHeight;
      if (!height) return;
      height = Math.round(height);
      if (height === lastHeight) return;
      lastHeight = height;
      document.documentElement.style.setProperty('--dx-app-height', height + 'px');
    });
  }

  syncClientViewport();
  window.addEventListener('resize', syncClientViewport, { passive: true });
  window.addEventListener('orientationchange', syncClientViewport, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncClientViewport, { passive: true });
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) syncClientViewport();
  });
})();
