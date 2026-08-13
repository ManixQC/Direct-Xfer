'use strict';

const SUBTITLE_MAX_BYTES = 4 * 1024 * 1024;
function srtToVtt(src) {
  const body = String(src)
    .replace(/\r+/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2'); // comma → dot in timecodes
  return /^WEBVTT/.test(body.trim()) ? body : 'WEBVTT\n\n' + body;
}
// Given a media filename and the sibling directory listing, find matching subtitle
// files: <base>.vtt / <base>.srt, optionally with a language tag (<base>.en.srt).
function subtitleTracksFor(mediaName, entries) {
  const dot = mediaName.lastIndexOf('.');
  const base = (dot > 0 ? mediaName.slice(0, dot) : mediaName).toLowerCase();
  const out = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const n = String(e.name);
    const m = /^(.*)\.(vtt|srt)$/i.exec(n);
    if (!m) continue;
    const stem = m[1].toLowerCase();
    if (stem === base) { out.push({ name: n, lang: '', label: m[2].toUpperCase() }); continue; }
    // <base>.<lang> form (e.g. movie.en.srt)
    if (stem.startsWith(base + '.')) {
      const lang = stem.slice(base.length + 1);
      if (/^[a-z]{2,3}([-_][a-z]{2,4})?$/i.test(lang)) out.push({ name: n, lang, label: lang.toUpperCase() });
    }
  }
  return out;
}


module.exports = { SUBTITLE_MAX_BYTES, srtToVtt, subtitleTracksFor };
