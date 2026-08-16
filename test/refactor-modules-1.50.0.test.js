'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const core = require('../lib/core-utils');
const auth = require('../lib/auth-utils');
const photos = require('../lib/photo-utils');
const subtitles = require('../lib/subtitle-utils');
const files = require('../lib/file-content-utils');
const text = require('../lib/text-render');
const search = require('../lib/search-utils');
const dlp = require('../lib/dlp-utils');

test('1.51.2 backend entry point delegates stateless helpers to lib modules', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const mod of ['core-utils','auth-utils','photo-utils','subtitle-utils','file-content-utils','text-render','search-utils','dlp-utils']) {
    assert.match(server, new RegExp(`require\\('\\./lib/${mod}'\\)`));
  }
  assert.doesNotMatch(server, /^function hashPassword\(/m);
  assert.doesNotMatch(server, /^function readPhotoMetadata\(/m);
  assert.doesNotMatch(server, /^function renderMarkdown\(/m);
  assert.doesNotMatch(server, /^function detectDlpFindings\(/m);
});

test('core and auth utility behavior is preserved', () => {
  assert.equal(core.int('42', 1), 42);
  assert.equal(core.int('nope', 7), 7);
  assert.equal(core.bool('YES'), true);
  assert.equal(core.parseTrustProxy('true'), 1);
  assert.equal(core.parseTrustProxy('3'), 3);
  assert.equal(core.flagFromCode('ca'), '🇨🇦');
  assert.equal(core.esc(`<script a="x">'&`), '&lt;script a=&quot;x&quot;&gt;&#39;&amp;');
  const stored = auth.hashPassword('secret');
  const rec = auth.parseHash(stored);
  assert.ok(rec && rec.salt.length && rec.hash.length);
  assert.equal(auth.verifyPassword('secret', rec), true);
  assert.equal(auth.verifyPassword('wrong', rec), false);
});

test('photo, subtitle and bounded-file helpers keep their prior contracts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-refactor-'));
  try {
    const png = Buffer.alloc(24);
    Buffer.from([0x89,0x50,0x4e,0x47]).copy(png, 0);
    png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
    const img = path.join(dir, 'sample.png'); fs.writeFileSync(img, png);
    assert.deepEqual(photos.imageDimensions(img), { w:640, h:480 });
    assert.equal(photos.previewInfo('sample.mp4').kind, 'video');
    assert.equal(photos.photoExt({ name:'x.jpeg' }), 'jpg');
    assert.match(subtitles.srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nHi'), /^WEBVTT/);
    const data = path.join(dir, 'data.txt'); fs.writeFileSync(data, 'abcdefghij');
    const capped = await files.readFileCapped(data, 4);
    assert.equal(capped.buf.toString(), 'abcd');
    assert.equal(capped.truncated, true);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('rendering, semantic search and DLP behavior is preserved', () => {
  const md = text.renderMarkdown('**Important** <script>alert(1)</script>');
  assert.match(md, /<strong>Important<\/strong>/);
  assert.match(md, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(text.renderKind('Dockerfile'), 'code');
  assert.ok(search.semanticTerms('facture').includes('invoice'));
  const findings = dlp.detectDlpFindings('card 4111 1111 1111 1111', 'sample.txt');
  assert.ok(findings.some((f) => f.type === 'payment-card'));
  assert.doesNotMatch(JSON.stringify(findings), /4111 1111 1111 1111/);
});

test('1.51.2 release identifiers remain synchronized', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
  assert.equal(pkg.version, '1.62.2');
  assert.match(app, /APP_VERSION = '1\.62\.2'/);
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(html, /v1\.62\.2 · pwa306/);
  assert.match(html, /app\.js\?v=290/);
});
