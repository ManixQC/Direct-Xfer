(function () {
  'use strict';
  var PREFIX = 'dx-media-pos-v1:';
  var MAX_AGE = 90 * 24 * 60 * 60 * 1000;
  function storageKey(el) {
    var src = '';
    try { src = el.currentSrc || el.src || ''; } catch (_) {}
    if (!src) return '';
    try { var u = new URL(src, location.href); src = u.pathname + u.search; } catch (_) {}
    return PREFIX + location.host + ':' + src;
  }
  function clear(key) {
    if (!key) return;
    try { localStorage.removeItem(key); } catch (_) {}
  }
  function read(key) {
    if (!key) return null;
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      if (!v || !isFinite(v.time) || !v.at || Date.now() - Number(v.at) > MAX_AGE) { clear(key); return null; }
      return v;
    } catch (_) { clear(key); return null; }
  }
  function save(el, force) {
    // Keep the key that belonged to the currently loaded track. A playlist may
    // change `src` before the old element's pause event is delivered; recomputing
    // the key here would save the previous track's position under the next track.
    var key = el.__dxResumeKey || storageKey(el);
    var t = Number(el.currentTime) || 0, d = Number(el.duration) || 0;
    if (!key || !isFinite(t)) return;
    // Rewinding to the beginning or reaching the end means "start fresh". Clear
    // an older saved position instead of silently leaving a stale resume point.
    if (t < 1 || (d && d - t < 5)) { clear(key); return; }
    var now = Date.now();
    if (!force && el.__dxResumeSavedAt && now - el.__dxResumeSavedAt < 2500) return;
    el.__dxResumeSavedAt = now;
    try { localStorage.setItem(key, JSON.stringify({ time:t, duration:d || 0, at:now })); } catch (_) {}
  }
  function attach(el) {
    if (!el || el.__dxResumeAttached) return;
    el.__dxResumeAttached = true;
    el.addEventListener('loadedmetadata', function () {
      var key = storageKey(el), d = Number(el.duration) || 0;
      el.__dxResumeKey = key;
      var v = read(key);
      if (!v || Number(v.time) < 5) return;
      var target = Number(v.time);
      if (d && target > d - 8) { clear(key); return; }
      try { el.currentTime = Math.max(0, target); } catch (_) {}
    });
    el.addEventListener('timeupdate', function () { save(el, false); });
    el.addEventListener('pause', function () { save(el, true); });
    el.addEventListener('ended', function () { clear(el.__dxResumeKey || storageKey(el)); });
  }
  function scan() { Array.prototype.forEach.call(document.querySelectorAll('video[data-dx-resume],audio[data-dx-resume]'), attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  window.addEventListener('pagehide', function () { Array.prototype.forEach.call(document.querySelectorAll('video[data-dx-resume],audio[data-dx-resume]'), function (el) { save(el, true); }); });
}());
