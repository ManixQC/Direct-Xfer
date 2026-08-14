'use strict';
// Direct-Xfer — burn-after-read secret note (recipient side). Fetches the
// ciphertext exactly once (the server burns it on that fetch) and decrypts it
// entirely in the browser. The key never leaves the page (URL fragment or a
// passphrase). Self-contained; relies only on dxcrypto.js.
(function () {
  var cfg = window.DX_SECRET || {};
  var S = cfg.strings || {};
  var token = cfg.token || '';
  var C = window.DXCrypto;
  var goBtn = document.getElementById('secret-go');
  var out = document.getElementById('secret-out');
  var copyBtn = document.getElementById('secret-copy');
  var status = document.getElementById('secret-status');
  if (!goBtn || !token) return;

  function setStatus(msg, err) { status.textContent = msg || ''; status.className = 'up-limits ' + (err ? 'err' : 'muted'); }

  // The AES key from the URL fragment (#k=…), never sent to the server. Allow the
  // optional base64url padding '=' in case an encoder emits it.
  function keyFromHash() {
    var m = /[#&]k=([A-Za-z0-9_=-]+)/.exec(location.hash || '');
    return m ? m[1] : '';
  }

  function reveal() {
    if (!C || !C.available) { setStatus(S.badKey, true); return; }
    var pass = '';
    if (cfg.mode === 'pass') {
      var el = document.getElementById('secret-pass');
      pass = el ? el.value : '';
      if (!pass) { setStatus(S.badKey, true); return; }
    } else if (!keyFromHash()) {
      setStatus(S.keyMissing, true); return;
    }
    goBtn.disabled = true;
    setStatus(S.working);
    // Fetch (and thereby burn) the ciphertext, then decrypt locally.
    fetch('/x/' + encodeURIComponent(token) + '/blob', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) throw new Error('gone');
        if (!r.ok) throw new Error('http');
        return r.arrayBuffer();
      })
      .then(function (buf) {
        return C.decrypt(new Blob([buf]), function (mode, salt) {
          if (mode === 'pass') return C.deriveKey(pass, salt);
          return C.importRawKey(C.b64urlDecode(keyFromHash()));
        });
      })
      .then(function (res) { return res.blob.text(); })
      .then(function (text) {
        out.value = text;
        out.style.display = '';
        copyBtn.style.display = '';
        goBtn.style.display = 'none';
        setStatus('');
        var pf = document.getElementById('secret-pass'); if (pf) pf.style.display = 'none';
      })
      .catch(function (e) {
        goBtn.disabled = false;
        if (e && e.message === 'gone') setStatus(S.gone, true);
        else setStatus(S.badKey, true); // wrong key/pass, or the blob is already burned
      });
  }

  // Make the one-shot nature explicit BEFORE the visitor reveals: once fetched the
  // ciphertext is burned server-side, so a wrong key can't be retried.
  if (S.oneShot) setStatus(S.oneShot);

  goBtn.addEventListener('click', reveal);
  if (copyBtn) copyBtn.addEventListener('click', function () {
    out.select();
    try { navigator.clipboard.writeText(out.value); } catch (_) { try { document.execCommand('copy'); } catch (e) {} }
    setStatus(S.copied);
  });
})();
