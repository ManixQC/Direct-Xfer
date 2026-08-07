'use strict';
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('dx-theme') || 'dark'; } catch (_) {}
  if (t !== 'light' && t !== 'auto' && t !== 'schedule') t = 'dark';
  var actual = t === 'schedule' ? ((new Date().getHours() >= 20 || new Date().getHours() < 7) ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', actual);
  document.documentElement.setAttribute('data-theme-mode', t);

  // Apply a saved custom accent colour before first paint (avoids a flash of the
  // default blue). Kept in sync with app.js applyAccent().
  try {
    var ac = localStorage.getItem('dx-accent');
    if (ac && /^#[0-9a-fA-F]{6}$/.test(ac)) {
      document.documentElement.style.setProperty('--accent', ac);
      document.documentElement.style.setProperty('--accent-2', ac);
    }
  } catch (_) {}

  var lastHeight = 0;
  var frame = 0;
  function syncClientViewport() {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(function () {
      frame = 0;
      var viewport = window.visualViewport;
      // visualViewport.height shrinks while the user pinch-zooms. Feeding that
      // temporary value into the fixed app shell collapses the body and leaves
      // only its blue background visible. Keep the last layout height during a
      // pinch; keyboard and orientation resizes still update normally at scale 1.
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
