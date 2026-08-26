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
  assert.doesNotMatch(launcher, /response\.Body\.Contains\("\\\"ok\\\":true"\)/);
});

test('optional Windows Tesseract is selected only when it can satisfy SEARCH_OCR_LANGS', () => {
  assert.match(host, /private static string\[\] RequestedOcrLanguages\(ProcessStartInfo start\)/);
  assert.match(host, /return new\[\] \{ "fra", "eng" \};/);
  assert.match(host, /TesseractUsable\(string executablePath, string tessdataPath, IEnumerable<string> requiredLanguages\)/);
  assert.match(host, /TesseractUsable\(OptionalTesseractPath, OptionalTessdataPath, requestedOcrLanguages\)/);
  assert.match(host, /requested\.All\(languages\.Contains\)/);
  assert.match(host, /optional Tesseract cannot satisfy the requested OCR languages/);
});

test('1.71.9 bump advances the PWA cache generation so changed release metadata is not served from pwa353', () => {
  assert.match(read('package.json'), /"version"\s*:\s*"1\.71\.9"/);
  for (const rel of ['pwa/app.js', 'pwa/index.html', 'pwa/sw.js', 'pwa/theme-init.js', 'pwa/admin-advanced.js', 'pwa/mobile-intelligence.js']) {
    const source = read(rel);
    assert.match(source, /1\.71\.9|pwa472|v=453/);
    assert.doesNotMatch(source, /1\.69\.12|pwa419|v=405|pwa353|v=353/);
  }
});
