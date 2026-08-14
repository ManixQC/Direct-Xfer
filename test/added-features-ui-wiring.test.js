'use strict';

// Static guards: the admin UI must actually surface + send the new fields so a
// refactor can't silently drop them. Behaviour is covered by the integration
// test (added-features-batch); this only pins the client wiring.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

test('#6 password hint + #24 per-IP quota are wired in the create and edit forms', () => {
  for (const id of ['opt-pwhint', 'opt-maxdlperip', 'edit-pwhint', 'edit-maxdlperip']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing input #${id}`);
  }
  // Create payload sends both fields.
  assert.match(app, /maxDownloadsPerIp: parseInt\(\$\('opt-maxdlperip'\)\.value, 10\) \|\| 0/);
  assert.match(app, /pwHint: \$\('opt-pwhint'\)/);
  // Edit payload sends both fields, and openEdit repopulates them.
  assert.match(app, /maxDownloadsPerIp: parseInt\(\$\('edit-maxdlperip'\)\.value, 10\) \|\| 0/);
  assert.match(app, /pwHint: \$\('edit-pwhint'\)/);
  assert.match(app, /\$\('edit-maxdlperip'\)\.value = s\.maxDownloadsPerIp/);
  assert.match(app, /\$\('edit-pwhint'\)\.value = s\.pwHint/);
});

test('#11 tag-by-sender + #12 per-sender caps are wired in the reception form', () => {
  for (const id of ['ib-tag-sender', 'ib-maxfiles-sender', 'ib-maxbytes-sender']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing input #${id}`);
  }
  assert.match(app, /tagBySender: \$\('ib-tag-sender'\)/);
  assert.match(app, /maxFilesPerSender: parseInt\(\$\('ib-maxfiles-sender'\)/);
  assert.match(app, /maxBytesPerSender: \$\('ib-maxbytes-sender'\)/);
  // Reset on modal open so stale values don't leak into the next link.
  assert.match(app, /\$\('ib-tag-sender'\)\.checked = false/);
});

test('#18 LQIP blur-up markup + styles are present', () => {
  assert.match(app, /img\.classList\.add\('lqip'\)/);
  assert.match(app, /lqip-loaded/);
  assert.match(css, /\.photo-thumb img\.lqip\b/);
  assert.match(css, /\.photo-thumb img\.lqip\.lqip-loaded/);
});

test('new i18n keys exist in all three admin languages', () => {
  for (const key of ['pk.maxDlPerIp', 'pk.pwHint', 'inbox.tagSender', 'inbox.maxFilesPerSender', 'inbox.maxBytesPerSender']) {
    const count = (app.match(new RegExp("'" + key.replace('.', '\\.') + "':", 'g')) || []).length;
    assert.ok(count >= 3, `i18n key ${key} should be in fr/en/es (found ${count})`);
  }
});
