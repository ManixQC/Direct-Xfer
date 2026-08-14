'use strict';
// Decrypt page for an end-to-end-encrypted download share. Fetches the ciphertext
// blob and decrypts it entirely in the browser (window.DX_ENC carries the config).
(function () {
  var cfg = window.DX_ENC;
  var C = window.DXCrypto;
  if (!cfg || !C || !C.available) return;
  var S = cfg.strings || {};
  var btn = document.getElementById('enc-go');
  var statusEl = document.getElementById('enc-status');
  var barWrap = document.getElementById('enc-barwrap');
  var bar = document.getElementById('enc-bar');
  var passEl = document.getElementById('enc-pass');
  if (!btn) return;

  function say(msg) { if (statusEl) statusEl.textContent = msg || ''; }
  function setBar(f) { if (barWrap) { barWrap.style.display = 'block'; bar.style.width = Math.round(f * 100) + '%'; } }
  function linkKey() { var m = /[#&]k=([A-Za-z0-9\-_]+)/.exec(location.hash || ''); return m ? m[1] : ''; }

  // getKey(mode, salt) -> Promise<CryptoKey>. Passphrase never touches the network;
  // the key-in-link lives only in the URL fragment (also never sent to the server).
  function getKey(mode, salt) {
    if (mode === 'pass') {
      var p = passEl ? passEl.value : '';
      if (!p) return Promise.reject(new Error('nopass'));
      return C.deriveKey(p, salt);
    }
    var k = linkKey();
    if (!k) return Promise.reject(new Error('nokey'));
    return C.importRawKey(C.b64urlDecode(k));
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  btn.addEventListener('click', function () {
    if (cfg.mode !== 'pass' && !linkKey()) { say(S.keyMissing); return; }
    btn.disabled = true;
    say(S.downloading);
    fetch('/s/' + encodeURIComponent(cfg.token) + '/enc', { credentials: 'same-origin' })
      // Blob (not arrayBuffer): the browser can disk-back it, so decrypting a large
      // file reads it in chunks instead of holding the whole ciphertext in memory.
      .then(function (r) { if (!r.ok) throw new Error('fetch'); return r.blob(); })
      .then(function (blob) { say(S.working); return C.decrypt(blob, getKey, setBar); })
      .then(function (res) { saveBlob(res.blob, res.name); say(S.ready); btn.disabled = false; })
      .catch(function (e) {
        btn.disabled = false;
        if (e && e.message === 'nopass') { say(''); if (passEl) passEl.focus(); return; }
        if (e && e.message === 'nokey') { say(S.keyMissing); return; }
        say(S.badKey);
      });
  });
})();
