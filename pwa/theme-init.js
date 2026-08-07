'use strict';
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('dx-theme') || 'dark'; } catch (_) {}
  if (t !== 'light' && t !== 'auto') t = 'dark';
  document.documentElement.setAttribute('data-theme', t);

  var lastHeight = 0;
  var frame = 0;
  function syncClientViewport() {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(function () {
      frame = 0;
      var viewport = window.visualViewport;
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
