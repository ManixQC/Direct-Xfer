'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const server = read('server.js');
const web = read('public', 'app.js');
const html = read('public', 'index.html');
const pwa = read('pwa', 'app.js');
const pwaHtml = read('pwa', 'index.html');

test('1.51.2 keeps color, private note and duplication as first-class link metadata/actions', () => {
  assert.match(server, /normalizeShareColor\(body\.color\)/);
  assert.match(server, /adminNote: s\.adminNote \|\| null/);
  assert.match(server, /adminRouter\.post\('\/shares\/:id\/clone'/);
  assert.match(web, /function cloneShare\(s, button\)/);
  assert.match(html, /id="opt-color"/);
  assert.match(pwaHtml, /id="share-color"/);
  assert.match(pwaHtml, /id="share-admin-note"/);
  assert.match(server, /app\.post\('\/app\/host\/shares\/:token\/clone'/);
  assert.match(server, /if \(source\.encrypted\) return res\.status\(400\)\.json\(\{ error:'cannot-clone' \}\)/);
});

test('revoked links can only be reactivated while backing data still exists', () => {
  assert.match(server, /async function shareReactivationAvailability\(sh\)/);
  assert.match(server, /async function reactivateRevokedShare\(sh, req\)/);
  assert.match(server, /if \(!sh\.revoked\) return \{ ok:false, status:409, error:'not-revoked' \}/);
  assert.match(server, /if \(!availability\.available\) return \{ ok:false, status:409, error:availability\.reason \|\| 'data-missing' \}/);
  assert.match(server, /sh\.revoked = false/);
  assert.doesNotMatch(server.match(/async function reactivateRevokedShare[\s\S]*?\n\}/)?.[0] || '', /downloads\s*=\s*0|maxDownloads\s*=|expiresAt\s*=/);
  assert.match(server, /adminRouter\.post\('\/shares\/:id\/reactivate'/);
  assert.match(server, /app\.post\('\/app\/host\/shares\/:token\/reactivate'/);
  assert.match(web, /function reactivateShare\(s, button\)/);
  assert.match(pwa, /function reactivateHostShare\(share\)/);
});

test('archiving and recoverable global trash are available in standard UI and PWA', () => {
  assert.match(server, /\['pin','unpin','archive','unarchive'\]/);
  assert.match(web, /bulkAction\(e\.currentTarget\.dataset\.action \|\| 'archive'\)/);
  assert.match(web, /async function loadTrash\(\)/);
  assert.match(pwaHtml, /id="share-archived-toggle"/);
  assert.match(pwaHtml, /id="share-trash-list"/);
  assert.match(server, /app\.get\('\/app\/trash'/);
  assert.match(server, /app\.post\('\/app\/trash\/:id\/restore'/);
  assert.match(pwa, /async function toggleHostShareArchive\(share\)/);
  assert.match(pwa, /async function restorePwaTrash\(id\)/);
});

test('global search spans content, links, users and logs with explicit scopes', () => {
  assert.match(html, /id="search-scope"/);
  for (const value of ['all','content','links','users','logs']) assert.match(html, new RegExp(`option value="${value}"`));
  assert.match(server, /function globalMetadataSearch\(q, req, limit, options\)/);
  assert.match(server, /scopes\.has\('links'\)/);
  assert.match(server, /scopes\.has\('users'\)/);
  assert.match(server, /scopes\.has\('logs'\)/);
  assert.match(server, /\['all','content','links','users','logs'\]\.includes\(requestedScope\)/);
  assert.match(server, /app\.get\('\/app\/search'/);
  assert.match(pwaHtml, /id="share-global-search"/);
  assert.match(pwa, /async function runPwaGlobalSearch\(\)/);
  // Account search results deliberately expose identity/role metadata, not auth secrets.
  const globalBlock = server.match(/function globalMetadataSearch[\s\S]*?\n\}\n\nfunction initUniversalSearchIndex/)?.[0] || '';
  assert.doesNotMatch(globalBlock, /pwHash|passwordHash|totpSecret|webauthnCredential|sessionToken/);
  assert.match(globalBlock, /!canSeeGlobalLogs && \(!h\.shareId \|\| !visibleShareIds\.has\(h\.shareId\)\)/);
});

test('1.51.2 release and PWA shell identifiers stay synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.4');
  assert.equal(lock.version, '1.59.4');
  assert.equal(lock.packages[''].version, '1.59.4');
  assert.match(pwa, /APP_VERSION = '1\.59\.4'/);
  assert.match(pwa, /APP_BUILD = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.14-pwa283'/);
  assert.match(pwaHtml, /v1\.59\.4 · pwa283/);
  assert.match(pwaHtml, /app\.js\?v=268/);
});
