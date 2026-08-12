'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DirectXferDlp = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis), function () {
  // Bump whenever detector/completeness semantics change. Queue fingerprints include
  // this value so a PWA update never trusts a "safe" result produced by an older engine.
  var ENGINE_VERSION = '3';
  var TEXT_EXTS = new Set([
    'txt','md','markdown','log','csv','tsv','json','jsonl','xml','yaml','yml','toml','ini','conf','cfg','env','properties',
    'js','mjs','cjs','ts','tsx','jsx','css','scss','sass','less','html','htm','xhtml','svg','sql','sh','bash','zsh','fish','ps1',
    'py','rb','php','pl','java','kt','kts','go','rs','c','h','cc','cpp','cxx','hpp','cs','swift','dart','vue','svelte','pem','key','crt','cer'
  ]);
  var TEXT_BASENAMES = new Set(['dockerfile','makefile','procfile','gemfile','rakefile','license','readme','changelog','.env','.npmrc','.gitconfig']);
  var ZIP_EXTS = new Set(['zip']);

  function extOf(name) {
    var base = String(name || '').split(/[\\/]/).pop().toLowerCase();
    var i = base.lastIndexOf('.');
    return i > 0 && i < base.length - 1 ? base.slice(i + 1) : '';
  }
  function basename(name) { return String(name || '').split(/[\\/]/).pop().toLowerCase(); }
  function luhnValid(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 9) return false;
    var sum = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var n = Number(digits[i]);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function ibanValid(value) {
    var iban = String(value || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    var moved = iban.slice(4) + iban.slice(0, 4), rem = 0;
    for (var i = 0; i < moved.length; i++) {
      var ch = moved[i], chunk = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
      for (var j = 0; j < chunk.length; j++) rem = (rem * 10 + Number(chunk[j])) % 97;
    }
    return rem === 1;
  }
  function redact(value) {
    var s = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= 8) return s.slice(0, 2) + '…';
    return s.slice(0, 4) + '…' + s.slice(-4);
  }
  function finding(type, severity, file, sample, detail) {
    return { type:type, severity:severity, file:String(file || '').slice(0, 512), sample:redact(sample), detail:String(detail || '').slice(0, 180) };
  }
  function detectFindings(text, file) {
    text = String(text || '');
    var findings = [], seen = new Set(), m;
    function add(type, severity, sample, detail) {
      var key = type + ':' + redact(sample);
      if (seen.has(key) || findings.length >= 100) return;
      seen.add(key); findings.push(finding(type, severity, file, sample, detail));
    }
    var privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gi;
    while ((m = privateKey.exec(text))) add('private-key','critical',m[0],'Private key material');
    var aws = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g; while ((m = aws.exec(text))) add('aws-access-key','critical',m[0],'AWS access key identifier');
    var github = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g; while ((m = github.exec(text))) add('github-token','critical',m[0],'GitHub token');
    var slack = /\bxox[baprs]-[A-Za-z0-9-]{10,200}\b/g; while ((m = slack.exec(text))) add('slack-token','critical',m[0],'Slack token');
    var jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g; while ((m = jwt.exec(text))) add('jwt','high',m[0],'JSON Web Token');
    var password = /(?:password|passwd|pwd|mot\s+de\s+passe|passphrase|contrase(?:n|ñ)a)\s*[:=]\s*([^\s'";,]{6,128})/gi;
    while ((m = password.exec(text))) add('password','high',m[1],'Password-like assignment');
    var api = /(?:api[_ -]?key|secret[_ -]?key|access[_ -]?token|client[_ -]?secret|bearer)\s*[:=]?\s*['"]?([A-Za-z0-9_\-\/+\=]{16,160})/gi;
    while ((m = api.exec(text))) add('api-secret','high',m[1],'API/token secret');
    var cards = /\b(?:\d[ -]*?){13,19}\b/g;
    while ((m = cards.exec(text))) {
      var digits = m[0].replace(/\D/g,'');
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) add('payment-card','high',m[0],'Payment-card number (Luhn valid)');
    }
    var sinContext = /(?:\bSIN\b|\bNAS\b|social\s+insurance|assurance\s+sociale|numero\s+d['’]?assurance\s+sociale)[^\d]{0,30}(\d{3}[ -]?\d{3}[ -]?\d{3})/gi;
    while ((m = sinContext.exec(text))) if (luhnValid(m[1])) add('canadian-sin','high',m[1],'Canadian SIN/NAS (Luhn valid)');
    var iban = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/gi;
    while ((m = iban.exec(text))) if (ibanValid(m[0])) add('iban','high',m[0],'IBAN (mod-97 valid)');
    var identity = /(?:passport|passeport|driver(?:'s)?\s+licen[cs]e|permis\s+de\s+conduire|pasaporte)[^A-Za-z0-9]{0,20}([A-Z0-9-]{5,24})/gi;
    while ((m = identity.exec(text))) add('identity-document','medium',m[1],'Identity-document number with context');
    var confidential = /\b(?:strictly\s+confidential|confidential|confidentiel|confidentielle|restricted|hautement\s+confidentiel|confidencial)\b/gi;
    while ((m = confidential.exec(text))) add('confidential-marker','medium',m[0],'Confidentiality marker');
    return findings;
  }
  function severityRank(v) { return ({ low:1, medium:2, high:3, critical:4 })[String(v || '').toLowerCase()] || 0; }
  function isIncomplete(summary) {
    return !!(summary && (summary.filesSkipped || summary.ocrErrors || summary.scanErrors || summary.incompleteEntries || summary.truncated || summary.error));
  }
  function summarize(findings, extra) {
    findings = Array.isArray(findings) ? findings.slice(0,100) : [];
    var highest = '', types = [];
    findings.forEach(function (f) {
      if (severityRank(f.severity) > severityRank(highest)) highest = f.severity;
      if (types.indexOf(f.type) === -1) types.push(f.type);
    });
    extra = extra || {};
    var out = {
      count:findings.length,
      highest:highest || null,
      types:types,
      findings:findings,
      filesScanned:Number(extra.filesScanned) || 0,
      filesSkipped:Number(extra.filesSkipped) || 0,
      ocrErrors:Number(extra.ocrErrors) || 0,
      scanErrors:Number(extra.scanErrors) || 0,
      incompleteEntries:Number(extra.incompleteEntries) || 0,
      truncated:!!extra.truncated
    };
    out.incomplete = isIncomplete(out);
    return out;
  }
  function looksTextName(name, type) {
    type = String(type || '').toLowerCase();
    if (/^(text\/|application\/(?:json|xml|javascript|x-javascript|x-httpd-php|sql|yaml|x-yaml))/.test(type)) return true;
    var e = extOf(name), b = basename(name);
    return TEXT_EXTS.has(e) || TEXT_BASENAMES.has(b) || /^\.env(?:\.|$)/.test(b);
  }
  function likelyTextBytes(bytes) {
    if (!bytes || !bytes.length) return true;
    var controls = 0, checked = Math.min(bytes.length, 8192);
    for (var i = 0; i < checked; i++) {
      var c = bytes[i];
      if (c === 0) return false;
      if (c < 9 || (c > 13 && c < 32)) controls++;
    }
    return controls / checked < 0.03;
  }
  async function blobText(blob) {
    if (blob && typeof blob.text === 'function') return blob.text();
    var ab = await blob.arrayBuffer();
    return new TextDecoder('utf-8', { fatal:false }).decode(new Uint8Array(ab));
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) { return null; }
  }
  function u16(dv, off) { return dv.getUint16(off, true); }
  function u32(dv, off) { return dv.getUint32(off, true); }
  async function zipInspectText(file, options) {
    options = options || {};
    var maxEntries = Math.max(1, Math.min(200, Number(options.maxZipEntries) || 60));
    var maxTextBytes = Math.max(65536, Math.min(8 * 1024 * 1024, Number(options.maxZipTextBytes) || 2 * 1024 * 1024));
    var bytes = new Uint8Array(await file.arrayBuffer()), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var start = Math.max(0, bytes.length - 65557), eocd = -1;
    for (var p = bytes.length - 22; p >= start; p--) { if (p + 4 <= bytes.length && u32(dv,p) === 0x06054b50) { eocd = p; break; } }
    if (eocd < 0) return { text:'', truncated:true, incompleteEntries:1, totalEntries:0, entriesVisited:0 };
    var diskNo = u16(dv,eocd + 4), cdDisk = u16(dv,eocd + 6), totalEntries = u16(dv,eocd + 10), cdOffset = u32(dv,eocd + 16);
    if (diskNo !== 0 || cdDisk !== 0 || totalEntries === 0xffff || cdOffset === 0xffffffff) {
      return { text:'', truncated:true, incompleteEntries:1, totalEntries:totalEntries, entriesVisited:0 };
    }
    var count = Math.min(totalEntries, maxEntries), off = cdOffset, out = [], totalText = 0, incompleteEntries = 0, visited = 0;
    var truncated = totalEntries > maxEntries;
    var decoder = new TextDecoder('utf-8', { fatal:false });
    if (truncated) incompleteEntries += Math.max(1, totalEntries - maxEntries);
    for (var i = 0; i < count && off + 46 <= bytes.length; i++) {
      if (u32(dv,off) !== 0x02014b50) { truncated = true; incompleteEntries++; break; }
      visited++;
      var flags = u16(dv,off + 8), method = u16(dv,off + 10), csize = u32(dv,off + 20), usize = u32(dv,off + 24);
      var nlen = u16(dv,off + 28), xlen = u16(dv,off + 30), clen = u16(dv,off + 32), local = u32(dv,off + 42);
      if (off + 46 + nlen + xlen + clen > bytes.length) { truncated = true; incompleteEntries++; break; }
      var name = decoder.decode(bytes.slice(off + 46, off + 46 + nlen)); out.push(name);
      var isDir = /\/$/.test(name), textCandidate = !isDir && looksTextName(name, '');
      if (textCandidate) {
        if ((flags & 1) || local === 0xffffffff || (method !== 0 && method !== 8) || usize > 1024 * 1024) {
          incompleteEntries++;
        } else if (totalText >= maxTextBytes) {
          incompleteEntries++; truncated = true;
        } else {
          try {
            if (local + 30 > bytes.length || u32(dv,local) !== 0x04034b50) throw new Error('zip-local-header');
            var ln = u16(dv,local + 26), lx = u16(dv,local + 28), dataStart = local + 30 + ln + lx;
            if (dataStart + csize > bytes.length) throw new Error('zip-data');
            var raw = bytes.slice(dataStart, dataStart + csize), plain = method === 0 ? raw : await inflateRaw(raw);
            if (!plain) throw new Error('zip-decompress');
            if (likelyTextBytes(plain)) {
              var remain = maxTextBytes - totalText, piece = plain.slice(0, remain);
              out.push(decoder.decode(piece)); totalText += piece.length;
              if (piece.length < plain.length) { incompleteEntries++; truncated = true; }
            }
          } catch (_) { incompleteEntries++; }
        }
      }
      off += 46 + nlen + xlen + clen;
    }
    if (visited < count) { truncated = true; incompleteEntries += Math.max(1, count - visited); }
    return { text:out.join('\n'), truncated:truncated, incompleteEntries:incompleteEntries, totalEntries:totalEntries, entriesVisited:visited };
  }
  async function zipSearchText(file, options) { return (await zipInspectText(file, options)).text; }
  async function scanFile(file, options) {
    options = options || {};
    var name = String(options.name || (file && file.name) || 'file'), type = String(options.type || (file && file.type) || '').toLowerCase();
    var size = Number(file && file.size) || 0, maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || 25 * 1024 * 1024);
    var findings = detectFindings(name, name), text = '', scanned = 0, skipped = 0, ocrErrors = 0, scanErrors = 0, incompleteEntries = 0, truncated = false;
    if (!file || size > maxBytes) return summarize(findings, { filesSkipped:1, truncated:true });
    scanned = 1;
    var ext = extOf(name);
    try {
      if (type === 'application/pdf' || ext === 'pdf') {
        if (typeof options.extractPdfText === 'function') {
          var pdfText = await options.extractPdfText(file, !!options.scanOcr);
          if (pdfText && typeof pdfText === 'object') {
            text = String(pdfText.text || '');
            incompleteEntries += Number(pdfText.incompletePages || pdfText.incompleteEntries) || 0;
            truncated = truncated || !!pdfText.truncated;
          } else text = String(pdfText || '');
        } else if (options.scanOcr) ocrErrors++;
      } else if (/^image\//.test(type) || /^(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif|tif|tiff)$/.test(ext)) {
        if (options.scanOcr) {
          if (typeof options.ocrImage === 'function') text = await options.ocrImage(file);
          else ocrErrors++;
        }
      } else if (ZIP_EXTS.has(ext) || type === 'application/zip' || type === 'application/x-zip-compressed') {
        var zip = await zipInspectText(file, options);
        text = zip.text; incompleteEntries += zip.incompleteEntries || 0; truncated = truncated || !!zip.truncated;
      } else if (looksTextName(name, type)) {
        text = await blobText(file.slice ? file.slice(0,maxBytes) : file);
      } else {
        var probeBlob = file.slice ? file.slice(0, Math.min(size,8192)) : file;
        var probe = new Uint8Array(await probeBlob.arrayBuffer());
        if (likelyTextBytes(probe)) text = await blobText(file.slice ? file.slice(0,maxBytes) : file);
      }
    } catch (_) {
      if ((type === 'application/pdf' || ext === 'pdf' || /^image\//.test(type)) && options.scanOcr) ocrErrors++;
      else scanErrors++;
    }
    if (text) findings = findings.concat(detectFindings(name + '\n' + text, name)).slice(0,100);
    // De-duplicate filename findings that are rediscovered when name is prepended.
    var uniq = [], seen = new Set();
    findings.forEach(function (f) { var k = f.type + ':' + f.sample + ':' + f.file; if (!seen.has(k)) { seen.add(k); uniq.push(f); } });
    return summarize(uniq, { filesScanned:scanned, filesSkipped:skipped, ocrErrors:ocrErrors, scanErrors:scanErrors, incompleteEntries:incompleteEntries, truncated:truncated });
  }
  async function scanFiles(files, options) {
    options = options || {}; files = Array.prototype.slice.call(files || []);
    var maxFiles = Math.max(1, Math.min(1000, Number(options.maxFiles) || 100)), all = [], scanned = 0, skipped = 0, ocrErrors = 0, scanErrors = 0, incompleteEntries = 0, truncated = files.length > maxFiles;
    for (var i = 0; i < files.length && i < maxFiles; i++) {
      var r = await scanFile(files[i].file || files[i], Object.assign({}, options, { name:files[i].name || (files[i].file && files[i].file.name), type:files[i].type || (files[i].file && files[i].file.type) }));
      all = all.concat(r.findings || []).slice(0,100); scanned += r.filesScanned || 0; skipped += r.filesSkipped || 0; ocrErrors += r.ocrErrors || 0; scanErrors += r.scanErrors || 0; incompleteEntries += r.incompleteEntries || 0; truncated = truncated || !!r.truncated;
      if (all.length >= 100) { truncated = true; break; }
    }
    if (files.length > maxFiles) skipped += files.length - maxFiles;
    return summarize(all, { filesScanned:scanned, filesSkipped:skipped, ocrErrors:ocrErrors, scanErrors:scanErrors, incompleteEntries:incompleteEntries, truncated:truncated });
  }
  return { version:ENGINE_VERSION, luhnValid:luhnValid, ibanValid:ibanValid, redact:redact, detectFindings:detectFindings, summarize:summarize, isIncomplete:isIncomplete, looksTextName:looksTextName, likelyTextBytes:likelyTextBytes, zipInspectText:zipInspectText, zipSearchText:zipSearchText, scanFile:scanFile, scanFiles:scanFiles };
});
