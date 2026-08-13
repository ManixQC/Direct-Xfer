'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'pwa', 'theme-init.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const feature = (number, name, fn) => test(`${number}. ${name}`, fn);

feature(1, 'bulk copy format is configurable and persisted', () => {
  for (const value of ['url', 'md', 'html', 'bb']) assert.match(html, new RegExp(`<option value="${value}">`));
  assert.match(js, /localStorage\.setItem\('dx-pwa-img-format'/);
  assert.match(js, /function copyAllImageLinks\(\)/);
});

feature(2, 'images can be sorted by date, name, size, views, visitors or expiry', () => {
  assert.match(html, /id="img-sort"/);
  for (const value of ['date-desc', 'date-asc', 'name', 'size', 'views', 'visitors', 'expiry']) assert.match(html, new RegExp(`value="${value}"`));
  assert.match(js, /if \(sort === 'views'\)/);
});

feature(3, 'compact image-card mode is available and remembered', () => {
  assert.match(html, /id="img-compact"/);
  assert.match(css, /\.imglink-list\.img-compact/);
  assert.match(js, /\['img-compact', false\]/);
  assert.match(js, /localStorage\.setItem\('dx-pwa-' \+ id/);
});

feature(4, 'expired images can be hidden without losing management access', () => {
  assert.match(html, /id="img-hide-expired"[^>]*checked/);
  assert.match(js, /if \(hideExpired && photo\.expired\) show = false/);
  assert.match(js, /includeInactive=1/);
});

feature(5, 'single-image revocation has an inline five-second undo window', () => {
  assert.match(js, /function scheduleImageRevoke\(/);
  assert.match(js, /pending-revoke/);
  assert.match(js, /imglink-revoke-undo/);
  assert.match(js, /imgCancelRevoke/);
  assert.match(js, /deadline = Date\.now\(\) \+ 5000/);
  assert.match(js, /}, 5000\);/);
});

feature(6, 'each image exposes a direct public-link action', () => {
  assert.match(js, /class="btn ghost sm il-open"/);
  // Opening goes through the authenticated owner preview (auto variant) so an owner's
  // own views never inflate the public counters; the public link stays available via copy.
  // The preview shows INSIDE the PWA (top-right ✕ to close) rather than a new browser tab,
  // so viewing an image no longer forces the user to leave the app.
  assert.match(js, /var url = imagePreviewUrl\(photo, 'auto'\);[\s\S]*?openImageUrlPreview\(url, photo\.name\)/);
  assert.match(js, /function openImageUrlPreview\(url, name\)/);
});

feature(7, 'instant search includes names, tokens, tags and private notes', () => {
  assert.match(html, /id="img-search"[^>]*type="search"/);
  assert.match(js, /\[photo\.name, token, \(photo\.tags \|\| \[\]\)\.join\(' '\), photo\.note \|\| ''\]/);
  assert.match(js, /addEventListener\('input', function \(\) \{ scheduleImageOcrSearch\(this\.value\); applyImageView\(\); \}\)/);
});

feature(8, 'quick filters cover active, popular, large, expiring, favorite and protected links', () => {
  for (const value of ['active', 'popular', 'large', 'expiring', 'favorite', 'protected']) assert.match(html, new RegExp(`value="${value}"`));
  assert.match(js, /filter === 'protected'/);
});

feature(9, 'automatic primary variant replaces the removed favorite-format setting', () => {
  assert.doesNotMatch(html, /id="img-default-variant"/);
  assert.doesNotMatch(js, /function imageDefaultVariant\(\)/);
  assert.match(js, /var IMAGE_PRIMARY_VARIANT = 'auto';/);
  assert.match(js, /var kind = IMAGE_PRIMARY_VARIANT;/);
});

feature(10, 'new image links can be copied automatically', () => {
  assert.match(html, /id="img-auto-copy"/);
  assert.match(js, /\$\('img-auto-copy'\) && \$\('img-auto-copy'\)\.checked/);
  assert.match(js, /formatLink\(imageVariantUrl\(photo, IMAGE_PRIMARY_VARIANT\)/);
});

feature(11, 'a favorite expiry is applied server-side and remembered', () => {
  assert.match(html, /id="img-expiry"/);
  assert.match(js, /expiresInSeconds: forceNeverExpire \? 0 : \(Number\(\$\('img-expiry'\)/);
  assert.match(server, /share\.expiresAt = parseExpiry\(body\.expiresInSeconds\)/);
});

feature(12, 'theme can follow the time of day', () => {
  assert.match(html, /<option value="schedule"/);
  assert.match(theme, /new Date\(\)\.getHours\(\) >= 20/);
  assert.match(js, /setInterval\(function \(\) \{ if \(\(\$\('theme-select'\)/);
  assert.match(js, /% order\.length/);
});

feature(13, 'multiple images can be selected for bulk actions', () => {
  assert.match(html, /id="img-select-all"/);
  assert.match(html, /id="img-bulk-bar"/);
  assert.match(js, /selectedImageTokens = new Set\(\)/);
  assert.match(server, /app\.post\('\/app\/images\/bulk'/);
});

feature(14, 'tags are editable, searchable and stored privately', () => {
  assert.match(html, /id="img-tags"/);
  assert.match(js, /tags: \$\('img-tags'\)/);
  assert.match(server, /share\.tags = tags/);
});

feature(15, 'private notes are editable and never embedded in public image URLs', () => {
  assert.match(html, /id="img-note"/);
  assert.match(js, /photo\.note \|\| ''/);
  assert.match(server, /share\.adminNote = note/);
  assert.match(server, /note: share\.adminNote \|\| ''/);
});

feature(16, 'duplicate images are detected with a local SHA-256 fingerprint', () => {
  assert.match(js, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(js, /\/app\/image\/duplicate\?hash=/);
  assert.match(server, /item\.contentSha256[\s\S]{0,120}item\.clientHash/);
});

feature(17, 'QR codes can be exported as PNG files', () => {
  assert.match(js, /async function downloadImageQr\(/);
  assert.match(js, /canvasBlob\(canvas, 'image\/png'\)/);
  assert.match(js, /-qr\.png/);
});

feature(18, 'image action history is durable and clearable', () => {
  assert.match(html, /id="img-action-history"/);
  assert.match(js, /dx-pwa-image-actions/);
  assert.match(js, /imageActionHistory = imageActionHistory\.slice\(0, 250\)/);
  assert.match(js, /img-action-history-clear/);
});

feature(19, 'advanced rename templates support name, extension, sequence, date and time', () => {
  assert.match(html, /id="img-rename-template"/);
  for (const token of ['name', 'ext', 'n', 'date', 'time']) assert.match(js, new RegExp(`\\\\{${token}\\\\}`, 'i'));
  assert.match(js, /String\(index \+ 1\)\.padStart\(3, '0'\)/);
});

feature(20, 'links expiring within 24 hours trigger in-app and optional system alerts', () => {
  assert.match(js, /function warnExpiringImages\(/);
  assert.match(js, /var deadline = imageExpiryDeadline\(photo\)/);
  assert.match(js, /deadline - now > 86400000/);
  assert.match(js, /new Notification\('Direct-Xfer'/);
});

feature(21, 'selected images can form public manageable albums', () => {
  assert.match(html, /id="img-bulk-album"/);
  assert.match(html, /id="img-album-list"/);
  assert.match(js, /\/app\/albums/);
  assert.match(server, /type: 'album'/);
  assert.match(server, /downloadRouter\.get\('\/g\/:token'/);
});

feature(22, 'the PWA includes a graphical image statistics dashboard', () => {
  assert.match(html, /id="img-dashboard-canvas"/);
  assert.match(js, /function drawImageDashboard\(/);
  assert.match(js, /\/app\/images\/dashboard\?days=' \+ encodeURIComponent\(days\)/);
  assert.match(server, /res\.json\(\{ totals: \{ images: photos\.length/);
});

feature(23, 'image links can stop automatically at a total view limit', () => {
  assert.match(html, /id="img-max-views"/);
  assert.match(server, /s\.type === 'photo' && Number\(s\.maxViews\) > 0/);
  assert.match(server, /totalViews >= Number\(s\.maxViews\)/);
  assert.match(server, /restrictedCache = !!s\.pwHash \|\| Number\(s\.maxViews\) > 0/);
});

feature(24, 'images and albums support password protection with no-store delivery', () => {
  assert.match(html, /id="img-password"[^>]*type="password"/);
  assert.match(server, /makeSharePassword\(body\.password\.slice\(0, 256\)\)/);
  assert.match(server, /downloadRouter\.post\('\/i\/:token\/unlock'/);
  assert.match(server, /downloadRouter\.post\('\/g\/:token\/unlock'/);
  assert.match(server, /if \(s\.pwHash && !isUnlocked\(req, s\)\)/);
  assert.match(server, /Cache-Control', 'no-store'/);
});
