'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('CodeQL hardening keeps RSA test fixtures at 2048 bits or stronger', () => {
  const files = [
    'test/storage-connector-google-direct-1.67.16.test.js',
    'test/storage-connector-google-direct-deep-audit-1.67.17.test.js',
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /modulusLength\s*:\s*1024\b/);
    assert.match(src, /modulusLength\s*:\s*(?:2048|3072|4096)\b/);
  }
});

test('Cloudflare broker route assertions do not build regular expressions from strings', () => {
  const src = read('test/oauth-broker-cloudflare-public-1.67.24.test.js');
  assert.match(src, /src\.includes\(route\)/);
  assert.doesNotMatch(src, /new RegExp\(route\.replace/);
});

test('XML search extraction decodes known entities in a single pass', () => {
  const src = read('lib/server/search-service.js');
  assert.match(src, /function decodeXmlSearchEntities\(/);
  assert.match(src, /replace\(\/&\(lt\|gt\|amp\|quot\|#39\);\/gi/);
  assert.doesNotMatch(src, /replace\(\/&lt;\/g[\s\S]{0,180}replace\(\/&amp;\/g/);
});

test('photo media paths encode tokens and constrain extensions before DOM URL assignment', () => {
  const src = read('public/app.js');
  assert.match(src, /function localPhotoMediaUrl\(token, ext, variant\)/);
  assert.match(src, /const mediaToken = encodeURIComponent\(String\(token \|\| ''\)\)/);
  assert.match(src, /const mediaExt = \/\^\[a-z0-9\]\{1,10\}\$\/\.test\(rawExt\) \? rawExt : 'jpg'/);
  assert.doesNotMatch(src, /'\/i\/' \+ s\.token/);
  assert.doesNotMatch(src, /'\/i\/' \+ photo\.token/);
});

test('dashboard donut rendering never reparses dynamic labels as HTML', () => {
  const src = read('public/app.js');
  assert.match(src, /function renderDonut\(target, parts, centerText, centerSub\)/);
  assert.match(src, /document\.createElementNS\(NS, 'svg'\)/);
  assert.match(src, /title\.textContent = String\(/);
  assert.match(src, /strong\.textContent = String\(/);
  assert.doesNotMatch(src, /function donutHtml\(/);
  assert.doesNotMatch(src, /\.innerHTML\s*=\s*donutHtml\(/);
});

test('custom logo files are decoded and pixel re-encoded before DOM URL use', () => {
  const src = read('public/app.js');
  const settings = read('lib/server/settings-service.js');
  const pages = read('lib/server/public-pages.js');
  assert.match(src, /async function sanitizeLogoFile\(file\)/);
  assert.match(src, /createImageBitmap\(file\)/);
  assert.match(src, /ctx\.drawImage\(bitmap/);
  assert.match(src, /canvas\.toDataURL\(/);
  assert.doesNotMatch(src, /reader\.readAsDataURL\(file\)/);
  assert.doesNotMatch(settings, /svg\\\+xml/);
  assert.doesNotMatch(pages, /svg\\\+xml/);
});

test('PWA file previews sanitize object URLs and constrain executable media contexts', () => {
  const src = read('pwa/app.js');
  assert.match(src, /function safePreviewMedia\(type, ext\)/);
  assert.match(src, /function safePreviewObjectUrl\(file, mime\)/);
  assert.match(src, /new Blob\(\[file\], \{ type: mime \}\)/);
  assert.match(src, /return encodeURI\(URL\.createObjectURL\(mediaBlob\)\)/);
  assert.match(src, /type === 'application\/pdf' && ext === 'pdf'/);
  assert.doesNotMatch(src, /lightboxUrl\s*=\s*URL\.createObjectURL\(file\)/);
  assert.doesNotMatch(src, /'image\/svg\+xml'\s*:/);
});

test('local photo media paths URI-encode both token and extension', () => {
  const src = read('public/app.js');
  assert.match(src, /const mediaToken = encodeURIComponent\(String\(token \|\| ''\)\)/);
  assert.ok(src.includes("return '/i/' + mediaToken + '.' + encodeURIComponent(mediaExt);"));
});


test('adjacent file-derived object URLs pass through a URI sanitizer or fixed media wrapper', () => {
  const web = read('public/app.js');
  const pwa = read('pwa/app.js');
  assert.match(web, /const url = encodeURI\(URL\.createObjectURL\(file\)\);/);
  assert.match(pwa, /var img = new Image\(\), url = encodeURI\(URL\.createObjectURL\(file\)\);/);
  assert.match(pwa, /var url = safePreviewObjectUrl\(it\.file, queuePreviewMedia\.mime\)/);
  assert.match(pwa, /preview = await safeImageLinkPreviewDataUrl\(file\)/);
  assert.doesNotMatch(pwa, /preview\s*=\s*URL\.createObjectURL\(file\)/);
  assert.match(pwa, /canvas\.toDataURL\('image\/jpeg', 0\.82\)/);
  assert.doesNotMatch(pwa, /var url = URL\.createObjectURL\(it\.file\)/);
});


test('CodeQL PWA manifest and image-link preview sinks accept only fixed or pixel-reencoded data', () => {
  const src = read('pwa/app.js');
  assert.match(src, /var manifestHref = '\/direct-xfer-pwa\.webmanifest\?v=481'/);
  assert.match(src, /if \(lang === 'en'\) manifestHref = '\/direct-xfer-pwa-en\.webmanifest\?v=481'/);
  assert.doesNotMatch(src, /manifest\.href\s*=.*\+\s*lang/);
  assert.match(src, /function managedImagePreviewUrl\(photo, kind\)/);
  assert.doesNotMatch(src, /var previews = photo && photo\.previewUrls/);
  assert.match(src, /async function safeImageLinkPreviewDataUrl\(file\)/);
  assert.match(src, /createImageBitmap\(file\)/);
  assert.match(src, /canvas\.toDataURL\('image\/jpeg', 0\.82\)/);
  assert.match(src, /function imgLinkRow\(name\)/);
  assert.doesNotMatch(src, /function imgLinkRow\(name, previewUrl/);
  assert.doesNotMatch(src, /previewIsObjectUrl/);
});

test('CodeQL dashboard heatmap and security widgets use DOM nodes instead of reparsing dynamic HTML', () => {
  const src = read('public/app.js');
  assert.match(src, /function renderHeatmap\(target, heat, max\)/);
  assert.match(src, /renderHeatmap\(\$\('dash-heatmap'\), d\.heatmap/);
  assert.doesNotMatch(src, /function heatmapHtml\(/);
  assert.doesNotMatch(src, /dash-heatmap'\)\.innerHTML/);
  const security = src.slice(src.indexOf('function renderSecurity(sec)'), src.indexOf('function renderStorage', src.indexOf('function renderSecurity(sec)')));
  assert.match(security, /box\.textContent = ''/);
  assert.match(security, /appendChild\(el\(/);
  assert.doesNotMatch(security, /innerHTML/);
});
