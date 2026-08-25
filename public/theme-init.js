'use strict';
(function () {
  var t;
  try { t = localStorage.getItem('dx-theme'); } catch (_) {}
  if (t !== 'light' && t !== 'auto') t = 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
