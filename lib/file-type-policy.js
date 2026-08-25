'use strict';

const path = require('path');
const { readFileCapped, readZipEntries } = require('./file-content-utils');

const EXECUTABLE_EXTENSIONS = new Set([
  'exe','dll','sys','scr','com','msi','msp','cpl','ocx','bat','cmd','ps1','psm1','vbs','vbe','wsf','wsh',
  'sh','bash','zsh','fish','appimage','dmg','pkg','deb','rpm','apk','jar','class',
]);

const TEXT_EXTENSIONS = new Set([
  'txt','md','markdown','csv','tsv','log','ini','cfg','conf','properties','yaml','yml','toml','json','jsonl','xml',
  'html','htm','css','js','mjs','cjs','ts','tsx','jsx','svg','srt','vtt','ics','vcf','sql','py','rb','php','java',
  'c','h','cc','cpp','hpp','cs','go','rs','swift','kt','kts','lua','r','pl','tex','rtf',
]);

function starts(buf, bytes) {
  if (!Buffer.isBuffer(buf) || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buf[i] !== bytes[i]) return false;
  return true;
}

function asciiAt(buf, offset, value) {
  if (!Buffer.isBuffer(buf) || buf.length < offset + value.length) return false;
  return buf.subarray(offset, offset + value.length).toString('ascii') === value;
}

function looksLikeNativeExecutable(buf) {
  if (!buf || buf.length < 4) return false;
  if (starts(buf, [0x4d,0x5a])) return true;
  if (starts(buf, [0x7f,0x45,0x4c,0x46])) return true;
  if (starts(buf, [0x23,0x21])) return true;
  const be = buf.readUInt32BE(0);
  return [0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe,0xbebafeca].includes(be);
}

function isValidUtf8Text(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal:true }).decode(buf);
    return true;
  } catch (_) {
    return false;
  }
}


function unsafeSvgContentReason(value) {
  const svg = String(value || '');
  // In the L3 upload profile SVG is treated as a passive image format only.
  // Active XML/HTML features are rejected instead of attempting a lossy sanitizer.
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(svg)) return 'svg-xml-declaration';
  if (/<\s*(?:script|foreignObject|iframe|frame|frameset|object|embed|applet|audio|video|canvas|style|link|meta)\b/i.test(svg)) return 'svg-active-element';
  if (/\son[a-z][a-z0-9:_-]*\s*=/i.test(svg)) return 'svg-event-handler';
  if (/\b(?:href|xlink:href|src)\s*=\s*(["'])\s*(?!#)[\s\S]*?\1/i.test(svg)) return 'svg-external-reference';
  if (/\b(?:href|xlink:href|src)\s*=\s*[^\s"'][^\s>]*/i.test(svg)) return 'svg-unquoted-reference';
  if (/\b(?:javascript|vbscript)\s*:/i.test(svg)) return 'svg-script-url';
  if (/url\s*\(\s*(["']?)(?:https?:|\/\/|data:|javascript:)/i.test(svg)) return 'svg-external-css-url';
  return null;
}

function simpleMagicMatches(ext, buf) {
  switch (ext) {
    case 'jpg': case 'jpeg': return starts(buf, [0xff,0xd8,0xff]);
    case 'png': return starts(buf, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    case 'gif': return asciiAt(buf, 0, 'GIF87a') || asciiAt(buf, 0, 'GIF89a');
    case 'bmp': return asciiAt(buf, 0, 'BM');
    case 'tif': case 'tiff': return asciiAt(buf, 0, 'II*\0') || asciiAt(buf, 0, 'MM\0*');
    case 'webp': return asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WEBP');
    case 'pdf': return asciiAt(buf, 0, '%PDF-');
    case 'gz': case 'gzip': return starts(buf, [0x1f,0x8b]);
    case 'bz2': return asciiAt(buf, 0, 'BZh');
    case 'xz': return starts(buf, [0xfd,0x37,0x7a,0x58,0x5a,0x00]);
    case '7z': return starts(buf, [0x37,0x7a,0xbc,0xaf,0x27,0x1c]);
    case 'rar': return starts(buf, [0x52,0x61,0x72,0x21,0x1a,0x07]);
    case 'wav': return asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WAVE');
    case 'avi': return asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'AVI ');
    case 'flac': return asciiAt(buf, 0, 'fLaC');
    case 'ogg': case 'oga': case 'ogv': return asciiAt(buf, 0, 'OggS');
    case 'mp3': return asciiAt(buf, 0, 'ID3') || (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    case 'mp4': case 'm4v': case 'm4a': case 'mov': case 'heic': case 'heif': return asciiAt(buf, 4, 'ftyp');
    case 'mkv': case 'webm': return starts(buf, [0x1a,0x45,0xdf,0xa3]);
    case 'ico': return starts(buf, [0x00,0x00,0x01,0x00]);
    case 'wasm': return starts(buf, [0x00,0x61,0x73,0x6d]);
    case 'tar': return asciiAt(buf, 257, 'ustar');
    default: return null;
  }
}

async function zipFamilyMatches(ext, absPath) {
  const zip = await readZipEntries(absPath, 4000);
  if (!zip || !Array.isArray(zip.entries) || !zip.entries.length) return false;
  const names = new Set(zip.entries.map((row) => String(row && row.name || '')));
  if (ext === 'zip') return true;
  if (['docx','docm','dotx','dotm'].includes(ext)) return names.has('[Content_Types].xml') && [...names].some((n) => n.startsWith('word/'));
  if (['xlsx','xlsm','xltx','xltm'].includes(ext)) return names.has('[Content_Types].xml') && [...names].some((n) => n.startsWith('xl/'));
  if (['pptx','pptm','potx','potm'].includes(ext)) return names.has('[Content_Types].xml') && [...names].some((n) => n.startsWith('ppt/'));
  if (['odt','ods','odp','odg'].includes(ext)) return names.has('mimetype') && names.has('META-INF/manifest.xml');
  if (ext === 'epub') return names.has('mimetype') && names.has('META-INF/container.xml');
  return false;
}

async function strictFileContentReason(absPath, filename) {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  if (!ext) return 'missing-extension';
  if (EXECUTABLE_EXTENSIONS.has(ext)) return 'content-blocked';
  const { buf, truncated } = await readFileCapped(absPath, 1024 * 1024);
  if (looksLikeNativeExecutable(buf)) return 'content-blocked';

  if (TEXT_EXTENSIONS.has(ext)) {
    if (!isValidUtf8Text(buf)) return 'file-type-mismatch';
    const text = buf.toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 2048).toLowerCase();
    if (ext === 'svg') {
      if (!/(^<\?xml\b|^<svg\b|<svg\b)/.test(text)) return 'file-type-mismatch';
      const unsafeSvg = unsafeSvgContentReason(buf.toString('utf8').replace(/^\uFEFF/, ''));
      if (unsafeSvg) return 'unsafe-svg';
    }
    if (ext === 'json' && !truncated) {
      try { JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch (_) { return 'file-type-mismatch'; }
    }
    return null;
  }

  if (['zip','docx','docm','dotx','dotm','xlsx','xlsm','xltx','xltm','pptx','pptm','potx','potm','odt','ods','odp','odg','epub'].includes(ext)) {
    return await zipFamilyMatches(ext, absPath) ? null : 'file-type-mismatch';
  }

  const magic = simpleMagicMatches(ext, buf);
  if (magic === true) return null;
  if (magic === false) return 'file-type-mismatch';
  return 'unverified-file-type';
}

module.exports = {
  EXECUTABLE_EXTENSIONS,
  TEXT_EXTENSIONS,
  looksLikeNativeExecutable,
  unsafeSvgContentReason,
  strictFileContentReason,
};
