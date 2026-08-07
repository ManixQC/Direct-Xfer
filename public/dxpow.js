/* Direct-Xfer — download challenge solver (feature 7).
 *
 * Runs on the interstitial page shown before a large download when the visitor
 * has no valid proof-of-work pass. It fetches a challenge, finds a suffix whose
 * SHA-256 has enough leading zero bits, posts the solution back (which sets a
 * short-lived cookie), then reloads to continue to the download.
 *
 * Self-contained SHA-256 in pure JS on purpose: the app is often served over
 * plain HTTP on a LAN, where window.crypto.subtle is unavailable. No third party
 * and no external script are involved. */
(function () {
  'use strict';

  // --- Minimal SHA-256 (returns a Uint8Array digest) ---
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256Bytes(bytes) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var l = bytes.length;
    var withOne = l + 1;
    var k = (56 - (withOne % 64) + 64) % 64;
    var total = withOne + k + 8;
    var m = new Uint8Array(total);
    m.set(bytes);
    m[l] = 0x80;
    var bitLen = l * 8;
    // 64-bit big-endian length (high 32 bits are 0 for our small inputs).
    m[total - 4] = (bitLen >>> 24) & 0xff;
    m[total - 3] = (bitLen >>> 16) & 0xff;
    m[total - 2] = (bitLen >>> 8) & 0xff;
    m[total - 1] = bitLen & 0xff;

    var w = new Int32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | (m[off + i * 4 + 3]);
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    var out = new Uint8Array(32), hs = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (i = 0; i < 8; i++) {
      out[i * 4] = (hs[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (hs[i] >>> 8) & 0xff;
      out[i * 4 + 3] = hs[i] & 0xff;
    }
    return out;
  }
  function utf8(str) {
    // TextEncoder is available in every browser that has Uint8Array (which the
    // pure-JS SHA-256 above already requires), so no deprecated fallback is needed.
    return new TextEncoder().encode(str);
  }
  function leadingZeroBits(d) {
    var n = 0;
    for (var i = 0; i < d.length; i++) {
      if (d[i] === 0) { n += 8; continue; }
      var v = d[i], c = 0;
      while ((v & 0x80) === 0) { c++; v <<= 1; }
      return n + c;
    }
    return n;
  }

  var statusEl = document.getElementById('pow-status');
  var barEl = document.getElementById('pow-bar');
  function setStatus(txt) { if (statusEl) statusEl.textContent = txt; }
  function setBar(pct) { if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%'; }

  function fail() {
    setStatus((statusEl && statusEl.getAttribute('data-fail')) || 'The verification failed. Please reload the page.');
    // Don't strand the visitor: reload after a short delay to retry the challenge.
    setTimeout(function () { window.location.reload(); }, 10000);
  }

  var SOLVE_MAX_MS = 5 * 60 * 1000; // give up (and fail/reload) after 5 minutes

  function solve(chal) {
    var prefix = chal.nonce;
    var bits = chal.bits | 0;
    var counter = 0;
    // A visual estimate: expected work is ~2^bits hashes (actual has a long tail).
    var expected = Math.pow(2, bits);
    var running = true;
    var startTime = Date.now();

    function tick() {
      if (!running) return;
      // Safety valve: never loop forever (e.g. a hash mismatch or impossible bits).
      if (Date.now() - startTime > SOLVE_MAX_MS) { running = false; fail(); return; }
      var deadline = Date.now() + 60; // keep the UI responsive
      while (Date.now() < deadline) {
        for (var i = 0; i < 500; i++) {
          var d = sha256Bytes(utf8(prefix + counter));
          if (leadingZeroBits(d) >= bits) {
            running = false;
            submit(chal, counter);
            return;
          }
          counter++;
        }
      }
      // Cap at 99%: the geometric tail can far exceed `expected`, so 100% is misleading.
      setBar(Math.min((counter / expected) * 100, 99));
      setTimeout(tick, 0);
    }
    setTimeout(tick, 0);
  }

  function submit(chal, sol) {
    setBar(100);
    setStatus((statusEl && statusEl.getAttribute('data-verify')) || 'Verifying…');
    fetch('/dx/pow/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: chal.nonce, exp: chal.exp, bits: chal.bits, sig: chal.sig, sol: String(sol) })
    }).then(function (r) {
      if (!r.ok) throw new Error('verify');
      return r.json();
    }).then(function () {
      window.location.reload();
    }).catch(fail);
  }

  fetch('/dx/pow', { headers: { 'Accept': 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('challenge'); return r.json(); })
    .then(solve)
    .catch(fail);
})();
