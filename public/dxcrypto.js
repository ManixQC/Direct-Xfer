'use strict';
// Direct-Xfer — browser-side end-to-end encryption (WebCrypto).
// Nothing here ever runs on the server: files are encrypted/decrypted only in
// the browser, so the server stores and serves opaque ciphertext.
//
// Cipher: AES-GCM 256. Key: a random 256-bit key (carried in the link fragment)
// OR derived from a passphrase via PBKDF2-SHA256. Large files are processed in
// 1 MiB chunks, each with its own random 96-bit IV.
//
// Container "DXE1" (self-describing; the original filename is encrypted too):
//   magic     4   "DXE1"
//   mode      1   0 = key-in-link, 1 = passphrase
//   saltLen   1   0 (key) or 16 (passphrase)
//   salt      saltLen   PBKDF2 salt (passphrase mode only)
//   metaIv    12
//   metaLen   4   big-endian, length of the encrypted metadata
//   metaCt    metaLen   AES-GCM({ name, size, type })
//   then repeated chunks:
//     iv      12
//     len     4   big-endian, ciphertext length (incl. 16-byte GCM tag)
//     ct      len
(function (root) {
  var MAGIC = [0x44, 0x58, 0x45, 0x31]; // "DXE1"
  var CHUNK = 1024 * 1024; // 1 MiB plaintext chunks
  var MAX_META = 65536; // hard cap on the encrypted-metadata length (anti-DoS on a crafted container)
  var PBKDF2_ITERS = 210000;
  var subtle = (root.crypto && root.crypto.subtle) || null;

  function b64urlEncode(bytes) {
    var b = new Uint8Array(bytes), bin = '';
    for (var i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function u32be(n) {
    var a = new Uint8Array(4);
    a[0] = (n >>> 24) & 255; a[1] = (n >>> 16) & 255; a[2] = (n >>> 8) & 255; a[3] = n & 255;
    return a;
  }
  function readU32be(b, o) { return (b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function randBytes(n) { return root.crypto.getRandomValues(new Uint8Array(n)); }
  function randIv() { return randBytes(12); }
  function randomSalt() { return randBytes(16); }
  function genRawKey() { return randBytes(32); }

  function importRawKey(raw) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  function deriveKey(pass, salt) {
    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(String(pass)), { name: 'PBKDF2' }, false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function encGCM(key, iv, data) { return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data); }
  function decGCM(key, iv, data) { return subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data); }

  // Encrypt a File/Blob -> Blob (DXE1 container).
  // mode: 'key' | 'pass'; opts: { key: CryptoKey, salt: Uint8Array (pass mode), onProgress(fraction) }
  function encryptFile(file, mode, opts) {
    opts = opts || {};
    var key = opts.key;
    var onProgress = opts.onProgress || function () {};
    // Passphrase mode MUST have a random salt — falling back to an empty salt would
    // make PBKDF2 rainbow-table-attackable. Auto-generate one when the caller omits it
    // (it's written into the header below and read back on decrypt).
    var salt = mode === 'pass' ? (opts.salt || randomSalt()) : new Uint8Array(0);
    // The container is assembled as a list of small Blobs — one per encrypted chunk.
    // Wrapping each chunk in a Blob immediately lets the browser move its bytes out
    // of the JS heap (disk-backed for big blobs), so encrypting a multi-GB file keeps
    // only ONE chunk in memory instead of the whole ciphertext (which used to OOM).
    var pieces = [];
    var meta = { name: file.name || 'file', size: file.size, type: file.type || '' };
    var metaIv = randIv();

    return encGCM(key, metaIv, new TextEncoder().encode(JSON.stringify(meta))).then(function (metaCtBuf) {
      var metaCt = new Uint8Array(metaCtBuf);
      var header = [
        new Uint8Array(MAGIC),
        new Uint8Array([mode === 'pass' ? 1 : 0]),
        new Uint8Array([salt.length]),
      ];
      if (salt.length) header.push(new Uint8Array(salt));
      header.push(metaIv, u32be(metaCt.length), metaCt);
      pieces.push(new Blob(header));

      var total = file.size, offset = 0;
      function nextChunk() {
        if (offset >= total) { onProgress(1); return Promise.resolve(); }
        var end = Math.min(offset + CHUNK, total);
        return file.slice(offset, end).arrayBuffer().then(function (buf) {
          var iv = randIv();
          return encGCM(key, iv, buf).then(function (ctBuf) {
            var ct = new Uint8Array(ctBuf);
            // Frame this chunk (iv + length + ciphertext) as its own Blob; the raw
            // ArrayBuffers are then free to be garbage-collected.
            pieces.push(new Blob([iv, u32be(ct.length), ct]));
            offset = end;
            onProgress(total ? offset / total : 1);
            return nextChunk();
          });
        });
      }
      if (total === 0) { onProgress(1); return Promise.resolve(); } // empty file: header only
      return nextChunk();
    }).then(function () {
      return new Blob(pieces, { type: 'application/octet-stream' });
    });
  }

  // Reads the container header from a Uint8Array.
  function parseHeader(b) {
    if (b.length < 18 || b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || b[2] !== MAGIC[2] || b[3] !== MAGIC[3]) {
      throw new Error('bad-magic');
    }
    var o = 4;
    var mode = b[o++] === 1 ? 'pass' : 'key';
    var saltLen = b[o++];
    var salt = b.subarray(o, o + saltLen); o += saltLen;
    var metaIv = b.subarray(o, o + 12); o += 12;
    var metaLen = readU32be(b, o); o += 4;
    if (!(metaLen >= 0) || metaLen > MAX_META) throw new Error('bad-magic'); // reject absurd/NaN metadata length
    var metaCt = b.subarray(o, o + metaLen); o += metaLen;
    return { mode: mode, salt: salt, metaIv: metaIv, metaCt: metaCt, bodyOffset: o };
  }

  // Peeks the container mode/salt without decrypting (so the UI can prompt for a
  // passphrase before doing the work). Accepts a Uint8Array/ArrayBuffer.
  function inspect(buf) {
    var h = parseHeader(new Uint8Array(buf));
    return { mode: h.mode, salt: h.salt };
  }

  // Reads just the container header from a Blob (fixed prefix → saltLen & metaLen →
  // the full header), so we never load the whole ciphertext to peek at it.
  function readHeaderBlob(blob) {
    return blob.slice(0, 64).arrayBuffer().then(function (pre) {
      var p = new Uint8Array(pre);
      if (p.length < 22 || p[0] !== MAGIC[0] || p[1] !== MAGIC[1] || p[2] !== MAGIC[2] || p[3] !== MAGIC[3]) {
        throw new Error('bad-magic');
      }
      var saltLen = p[5];
      var metaLenOff = 6 + saltLen + 12; // magic(4)+mode(1)+saltLen(1) + salt + metaIv(12)

      function finish(hdr) {
        var metaLen = readU32be(hdr, metaLenOff);
        if (!(metaLen >= 0) || metaLen > MAX_META) throw new Error('bad-magic');
        var bodyOffset = metaLenOff + 4 + metaLen;
        return blob.slice(0, bodyOffset).arrayBuffer().then(function (hbuf) {
          return parseHeader(new Uint8Array(hbuf));
        });
      }
      // A large saltLen can push metaLen past the 64-byte peek; re-fetch just enough
      // to read it (instead of indexing out of bounds → NaN offsets).
      if (metaLenOff + 4 <= p.length) return finish(p);
      return blob.slice(0, metaLenOff + 4).arrayBuffer().then(function (h2) { return finish(new Uint8Array(h2)); });
    });
  }

  // Decrypt a container. `source` may be a Blob/File (read incrementally — only one
  // chunk is held in memory, so very large files don't OOM) or an ArrayBuffer/
  // Uint8Array (wrapped in a Blob). getKey(mode, salt) -> Promise<CryptoKey> lets the
  // caller derive the key (e.g. prompt for a passphrase). Returns { blob, name, type, size }.
  function decrypt(source, getKey, onProgress) {
    onProgress = onProgress || function () {};
    var blob = (typeof Blob !== 'undefined' && source instanceof Blob) ? source : new Blob([source]);
    return readHeaderBlob(blob).then(function (h) {
      return Promise.resolve(getKey(h.mode, h.salt)).then(function (key) {
        return decGCM(key, h.metaIv, h.metaCt).then(function (metaBuf) {
          var meta = JSON.parse(new TextDecoder().decode(new Uint8Array(metaBuf)));
          var pieces = [], o = h.bodyOffset, done = 0;
          function nextChunk() {
            if (o >= blob.size) return Promise.resolve();
            // Frame = iv(12) + len(4) + ciphertext(len). Read the 16-byte frame head first.
            return blob.slice(o, o + 16).arrayBuffer().then(function (fbuf) {
              var f = new Uint8Array(fbuf);
              if (f.length < 16) throw new Error('truncated-container'); // frame head cut short
              var iv = f.subarray(0, 12);
              var len = readU32be(f, 12);
              var cstart = o + 16;
              return blob.slice(cstart, cstart + len).arrayBuffer().then(function (ctbuf) {
                return decGCM(key, iv, ctbuf).then(function (ptBuf) {
                  pieces.push(new Blob([new Uint8Array(ptBuf)])); // keep plaintext off the JS heap
                  o = cstart + len;
                  done += ptBuf.byteLength;
                  onProgress(meta.size ? Math.min(1, done / meta.size) : 1);
                  return nextChunk();
                });
              });
            });
          }
          return nextChunk().then(function () {
            onProgress(1);
            return {
              blob: new Blob(pieces, { type: meta.type || 'application/octet-stream' }),
              name: meta.name, type: meta.type, size: meta.size,
            };
          });
        });
      });
    });
  }

  root.DXCrypto = {
    available: !!subtle,
    CHUNK: CHUNK,
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    genRawKey: genRawKey,
    randomSalt: randomSalt,
    importRawKey: importRawKey,
    deriveKey: deriveKey,
    encryptFile: encryptFile,
    decrypt: decrypt,
    inspect: inspect,
  };
})(window);
