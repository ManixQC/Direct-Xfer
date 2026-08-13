'use strict';
// Direct-Xfer — folder media player. Plays the folder's audio/video
// as a playlist, loads sibling subtitles for videos, and auto-advances.
(function () {
  var cfg = window.DX_PLAYER || { items: [], strings: {} };
  var items = cfg.items || [];
  var video = document.getElementById('dxp-video');
  var nowEl = document.getElementById('dxp-now');
  var dlEl = document.getElementById('dxp-dl');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.dxp-track'));
  if (!video || !items.length) return;
  var current = -1;

  function clearTracks() {
    var ts = video.querySelectorAll('track');
    Array.prototype.forEach.call(ts, function (t) { video.removeChild(t); });
  }

  // Neutralize dangerous URL schemes (javascript:/data:/vbscript:) while keeping
  // the server's relative URLs (/s/<token>/…) and plain http(s) working.
  function safeUrl(u) {
    u = String(u || '');
    return /^\s*(javascript|data|vbscript):/i.test(u) ? '#' : u;
  }

  function play(i) {
    if (i < 0 || i >= items.length) return;
    current = i;
    var m = items[i];
    clearTracks();
    video.src = safeUrl(m.src);
    video.setAttribute('data-kind', m.kind);
    if (m.kind === 'video' && m.subs) {
      m.subs.forEach(function (s, idx) {
        var tr = document.createElement('track');
        tr.kind = 'subtitles';
        tr.src = safeUrl(s.src);
        tr.label = s.label || ('Sub ' + (idx + 1));
        if (s.lang) tr.srclang = s.lang;
        if (idx === 0) tr.default = true;
        video.appendChild(tr);
      });
    }
    if (nowEl) nowEl.textContent = m.name;
    if (dlEl) dlEl.href = safeUrl(m.dl);
    rows.forEach(function (r, ri) { r.classList.toggle('active', ri === i); });
    video.load();
    var p = video.play();
    // Autoplay may be blocked (user can press play); surface anything else.
    if (p && p.catch) p.catch(function (err) { if (err && err.name !== 'NotAllowedError') console.warn('DXPlayer:', err && err.message); });
  }

  rows.forEach(function (r) {
    r.addEventListener('click', function () { play(parseInt(r.getAttribute('data-i'), 10) || 0); });
  });
  video.addEventListener('ended', function () {
    if (current + 1 < items.length) play(current + 1);
  });

  play(0);
})();
