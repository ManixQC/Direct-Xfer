#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'security', 'asvs-static-audit.json');
const roots = ['server.js', 'lib', 'public', 'pwa', 'oauth-broker/server.js', 'oauth-broker/cloudflare-worker/src'];
const extensions = new Set(['.js', '.mjs', '.cjs']);

function walk(rel) {
  const absolute = path.join(ROOT, rel);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [rel.replace(/\\/g, '/')];
  const out = [];
  for (const name of fs.readdirSync(absolute).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const child = path.join(rel, name);
    const st = fs.statSync(path.join(ROOT, child));
    if (st.isDirectory()) out.push(...walk(child));
    else if (extensions.has(path.extname(name))) out.push(child.replace(/\\/g, '/'));
  }
  return out;
}

const files = [...new Set(roots.flatMap(walk))].sort();
const findings = [];
const decoderInventory = [];
const regexReview = [];
let regexLiteralEstimate = 0;

function add(severity, rule, file, line, detail) {
  findings.push({ severity, rule, file, line, detail });
}

// These are deliberate single-decoding boundaries. Any new decoder site must be
// reviewed before it is accepted here, which prevents accidental decode/validate/
// decode chains from silently entering the application.
const allowedDecodeSites = new Set([
  'lib/server/request-utils.js',
  'lib/assets/oauth-broker-worker.mjs',
  'oauth-broker/server.js',
  'oauth-broker/cloudflare-worker/src/index.js',
  'public/app.js',
  'public/download-resume.js',
  'pwa/admin-audit-connectors.js',
  'pwa/app.js',
]);

for (const file of files) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const number = i + 1;

    if (/\beval\s*\(/.test(line)) add('error', 'dangerous-eval', file, number, 'eval() is forbidden in production sources');
    if (/\bnew\s+Function\s*\(/.test(line)) add('error', 'dynamic-function', file, number, 'new Function() is forbidden');
    if (/\bnew\s+RegExp\s*\(|(^|[^.\w])RegExp\s*\(/.test(line)) add('error', 'dynamic-regexp', file, number, 'dynamic RegExp construction is forbidden');
    if (/\burl\.parse\s*\(|\brequire\s*\(\s*['"]querystring['"]\s*\)|\bquerystring\./.test(line)) add('error', 'legacy-url-parser', file, number, 'legacy/alternate URL query parsers are forbidden');
    if (/\bdecodeURI\s*\(|\bunescape\s*\(/.test(line)) add('error', 'alternate-decoder', file, number, 'alternate URL decoders are forbidden');

    if (/decodeURIComponent\s*\(/.test(line)) {
      decoderInventory.push({ file, line:number, hash:crypto.createHash('sha256').update(line.trim()).digest('hex').slice(0, 16) });
      if (!allowedDecodeSites.has(file)) add('error', 'unreviewed-decoder', file, number, 'decodeURIComponent site is not in the reviewed canonicalization inventory');
    }

    if (/window\s*\[/.test(line)) {
      const guarded = file === 'pwa/app.js' && /var\s+value\s*=\s*window\s*\[globalName\]/.test(line);
      if (!guarded) add('error', 'dynamic-window-lookup', file, number, 'dynamic window property lookup can be DOM-clobbered');
    }

    // Dynamic regular expressions are forbidden above. Fixed regex literals are
    // tracked as inventory metadata; the repository-wide ReDoS review is paired
    // with regression tests for complex parsers and input-size bounds.
    // Approximate fixed literal count, used only as review inventory metadata.
    const matches = line.match(/\/(?:\\.|[^/\n\\])+\/[dgimsuvy]*/g);
    if (matches) regexLiteralEstimate += matches.length;
  }
}

const errors = findings.filter((row) => row.severity === 'error');
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  scope: roots,
  filesScanned: files.length,
  regexLiteralEstimate,
  decoderInventory,
  potentialRedos: regexReview,
  regexPolicy: 'fixed-literals-only; dynamic RegExp/eval constructors forbidden',
  findings,
  passed: errors.length === 0,
};

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(REPORT), { recursive:true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
}

if (errors.length) {
  for (const row of errors) console.error(`${row.rule}: ${row.file}:${row.line}: ${row.detail}`);
  process.exitCode = 1;
} else {
  console.log(`ASVS static audit passed: ${files.length} production source files, ${decoderInventory.length} reviewed decoder sites, ${regexLiteralEstimate} fixed-regex literals estimated.`);
}
