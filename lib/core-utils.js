'use strict';

const crypto = require('crypto');

function int(value, def) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : def;
}
function bool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function parseTrustProxy(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || ['false', '0', 'no', 'off'].includes(s)) return false;
  if (['true', 'yes', 'on'].includes(s)) return 1;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : false;
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.');
  const pb = String(b).replace(/^v/, '').split('.');
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Resolves the newest published version. Prefers the version tag that shares the
// reference tag's digest ("what latest points to"), else the highest semver tag.
function isPrivateIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  if (!v || v === '127.0.0.1' || v === '::1') return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^f[cd]/i.test(v)) return true; // IPv6 unique local
  return false;
}

// --- Server local network (auto-detection of subnets) ---
function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  const n = ((parseInt(p[0], 10) << 24) | (parseInt(p[1], 10) << 16) | (parseInt(p[2], 10) << 8) | parseInt(p[3], 10)) >>> 0;
  return Number.isFinite(n) ? n : null;
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function maskToPrefix(mask) {
  const m = ipToInt(mask);
  if (m == null) return null;
  let count = 0, x = m >>> 0;
  for (let i = 0; i < 32; i++) { if ((x >>> 31) & 1) count++; x = (x << 1) >>> 0; }
  return count;
}

function parseIpList(str) {
  const out = [];
  for (const raw of String(str || '').split(/[\s,]+/)) {
    const item = raw.trim();
    if (!item) continue;
    const slash = item.indexOf('/');
    const base = ipToInt(slash === -1 ? item : item.slice(0, slash));
    if (base == null) continue; // invalid entry -> ignored
    let prefix = slash === -1 ? 32 : parseInt(item.slice(slash + 1), 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) prefix = 32;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    out.push({ base: (base & mask) >>> 0, mask });
  }
  return out;
}
function ipInList(ip, list) {
  const n = ipToInt(String(ip || '').replace(/^::ffff:/i, ''));
  if (n == null) return false;
  for (const net of list) if (((n & net.mask) >>> 0) === net.base) return true;
  return false;
}
function isLoopback(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  return v === '::1' || v.startsWith('127.');
}

// Emoji flag from the ISO-3166 country code (regional indicators).
function flagFromCode(cc) {
  const c = String(cc || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (c.length !== 2) return '🌐';
  const base = 0x1f1e6;
  return c.split('').map((ch) => String.fromCodePoint(base + ch.charCodeAt(0) - 65)).join('');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Serializes an object for embedding inside an inline <script> tag. Escapes `<`
// (and the U+2028/U+2029 line separators) so a value containing `</script>` — e.g.
// an uploaded/host file name — can't break out of the script element. The strict
// CSP already blocks inline execution, but this keeps the embed safe on its own.
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// One CSV cell: RFC-4180 quoting AND spreadsheet formula-injection defense. A cell
// starting with = + - @ (or a control char Excel treats as a formula lead) is
// prefixed with an apostrophe, because journal/audit fields include untrusted
// uploader-supplied filenames \u2014 a name like =HYPERLINK(...) must not execute when
// the admin opens the export in Excel/LibreOffice.
function csvField(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

module.exports = {
  int, bool, parseTrustProxy, compareSemver,
  isPrivateIp, ipToInt, intToIp, maskToPrefix, parseIpList, ipInList, isLoopback, flagFromCode,
  timingSafeEqualStr, esc, jsonForScript, csvField, formatBytes, encodePath,
};
