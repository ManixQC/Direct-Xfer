'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');

test('malformed optional Windows path overrides fall back instead of crashing startup', () => {
  for (const source of [launcher, host]) {
    assert.match(source, /DX_WINDOWS_PORTABLE_ROOT[\s\S]*?try \{ return Path\.GetFullPath\(overridden\.Trim\(\)\); \}[\s\S]*?catch \{ \/\* Invalid optional override: fall back to the packaged executable directory\. \*\/ \}/);
  }
  assert.match(host, /foreach \(var value in new\[\] \{ env, Path\.Combine\(RuntimeRoot, "app"\) \}\)[\s\S]*?try \{ full = Path\.GetFullPath\(value\.Trim\(\)\); \}[\s\S]*?catch \{ continue; \}/);
});

test('launcher readiness validates structured authenticated JSON instead of substring matches', () => {
  assert.match(launcher, /Json\.Deserialize<Dictionary<string, object\?>>\(response\.Body\)/);
  assert.match(launcher, /GetBool\(payload, "ok"\)/);
  assert.match(launcher, /string\.Equals\(GetString\(payload, "app"\), "Direct-Xfer", StringComparison\.Ordinal\)/);
  assert.match(launcher, /GetInt32\(payload, "pid"\) == expectedPid/);
  assert.match(launcher, /private static int GetInt32\(IDictionary<string, object\?>\? payload, string key\)/);
  assert.doesNotMatch(launcher, /response\.Body\.Contains\("\\\"ok\\\":true"\)/);
  assert.doesNotMatch(launcher, /response\.Body\.Contains\("\\\"pid\\\":"/);
});


test('bundled Windows Tesseract is selected only when it can satisfy SEARCH_OCR_LANGS', () => {
  assert.match(host, /private static string\[\] RequestedOcrLanguages\(ProcessStartInfo start\)/);
  assert.match(host, /SEARCH_OCR_LANGS/);
  assert.match(host, /return new\[\] \{ "fra", "eng" \};/);
  assert.match(host, /BundledTesseractUsable\(IEnumerable<string> requiredLanguages\)/);
  assert.match(host, /var requestedOcrLanguages = RequestedOcrLanguages\(start\);/);
  assert.match(host, /BundledTesseractUsable\(requestedOcrLanguages\)/);
  assert.match(host, /requested\.All\(languages\.Contains\)/);
  assert.match(host, /bundled Tesseract cannot satisfy the requested OCR languages/);
});

test('1.66.4 bump advances the PWA cache generation so changed release metadata is not served from pwa353', () => {
  assert.match(read('package.json'), /"version"\s*:\s*"1\.66\.4"/);
  for (const rel of ['pwa/app.js', 'pwa/index.html', 'pwa/sw.js', 'pwa/theme-init.js', 'pwa/admin-advanced.js', 'pwa/mobile-intelligence.js']) {
    const source = read(rel);
    assert.match(source, /1\.66\.4|pwa354|v=354/);
    assert.doesNotMatch(source, /pwa353|v=353/);
  }
});
