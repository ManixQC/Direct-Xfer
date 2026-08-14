'use strict';

const crypto = require('crypto');

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function parseHash(stored) {
  const m = /^scrypt\$([^$]+)\$([^$]+)$/.exec(String(stored || '').trim());
  if (!m) return null;
  try {
    return { salt: Buffer.from(m[1], 'base64'), hash: Buffer.from(m[2], 'base64') };
  } catch (_) {
    return null;
  }
}
function verifyPassword(plain, rec) {
  if (!rec || !rec.hash || !rec.hash.length) return false;
  let cand;
  try {
    cand = crypto.scryptSync(String(plain), rec.salt, rec.hash.length);
  } catch (_) {
    return false;
  }
  return cand.length === rec.hash.length && crypto.timingSafeEqual(cand, rec.hash);
}


module.exports = { hashPassword, parseHash, verifyPassword };
