'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createWebStorageShareTools } = require('../lib/web-storage-share');
const { createWebStorageWritableTools } = require('../lib/web-storage-writable');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function storageShare() {
  return {
    id:'share-1', type:'collab',
    webStorage:{ connectorId:'connector-1', connectorName:'Cloud', connectorType:'webdav', remote:'cloud', root:'tenant', path:'shared/root', isDir:true, readOnly:false },
  };
}

test('ASVS V1 canonicalization/parser inventory remains single-decoder and modern-parser only', () => {
  const run = spawnSync(process.execPath, ['scripts/asvs-static-audit.js', '--write'], { cwd:ROOT, encoding:'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(read('security/asvs-static-audit.json'));
  assert.equal(report.passed, true);
  assert.ok(report.filesScanned >= 100);
  assert.ok(report.decoderInventory.length > 0);
  assert.equal(report.findings.length, 0);
});

test('ASVS V1 ReDoS gate forbids attacker-controlled regular-expression construction', () => {
  const report = JSON.parse(read('security/asvs-static-audit.json'));
  assert.match(report.regexPolicy, /dynamic RegExp\/eval constructors forbidden/);
  assert.ok(report.regexLiteralEstimate > 0);
  assert.deepEqual(report.potentialRedos, []);
});

test('ASVS V3 DOM globals are resolved as own window properties to resist clobbering', () => {
  const pwa = read('pwa/app.js');
  assert.match(pwa, /Object\.prototype\.hasOwnProperty\.call\(window, globalName\)/);
  assert.match(pwa, /var value=window\[globalName\]/);
  assert.doesNotMatch(pwa, /if \(window\[globalName\]\)/);
  assert.doesNotMatch(pwa, /tag\.onload=function\(\)\{window\[globalName\]/);
});

test('ASVS V8 delegated storage reads are fenced to the originating share capability', async () => {
  const calls = [];
  const service = {
    async stat(meta, full) { calls.push(['stat', meta, full]); return { name:'x', path:full, isDir:false, size:1, id:'id', modTime:'2026-08-24T00:00:00Z' }; },
    async list(meta, full) {
      calls.push(['list', meta, full]);
      return [
        { name:'inside.txt', path:'shared/root/inside.txt', isDir:false, size:1 },
        { name:'outside.txt', path:'other/private.txt', isDir:false, size:1 },
      ];
    },
  };
  const tools = createWebStorageShareTools({ storageConnectorService:service });
  const share = storageShare();
  await tools.stat(share, 'folder/a.txt');
  const listed = await tools.list(share, '');
  assert.equal(calls[0][2], 'shared/root/folder/a.txt');
  assert.equal(calls[0][1].remote, 'cloud');
  assert.equal(calls[0][1].root, 'tenant');
  assert.deepEqual(listed.map((row) => row.rel), ['inside.txt']);
  const before = calls.length;
  await assert.rejects(tools.stat(share, '../private.txt'), /invalid-web-storage-share/);
  assert.equal(calls.length, before, 'traversal must be rejected before the intermediary connector is called');
});

test('ASVS V8 delegated storage writes cannot escape the originating share root', async () => {
  const calls = [];
  const service = {
    async stat() { throw Object.assign(new Error('missing'), { code:'remote-not-found' }); },
    async list() { return []; },
    async exportFile(meta, local, full) { calls.push(['export', meta, full]); return { ok:true }; },
    async mkdir(meta, full) { calls.push(['mkdir', meta, full]); return { ok:true }; },
    async remove(meta, full) { calls.push(['remove', meta, full]); return { ok:true }; },
  };
  const shares = createWebStorageShareTools({ storageConnectorService:service });
  const writable = createWebStorageWritableTools({ storageConnectorService:service, shareMeta:shares.shareMeta, joinedPath:shares.joinedPath, stat:shares.stat });
  const share = storageShare();
  await writable.mkdir(share, 'child');
  assert.equal(calls[0][2], 'shared/root/child');
  const before = calls.length;
  await assert.rejects(writable.remove(share, '../private', { isDir:true }), /invalid-remote-path/);
  assert.equal(calls.length, before);
});

test('ASVS V3 sensitive API GET/navigation requests are rejected cross-site via Fetch Metadata', () => {
  const http = read('lib/server/http-application.js');
  const start = http.indexOf('// Fetch Metadata adds');
  const end = http.indexOf('// CSP reports are intentionally', start);
  assert.ok(start >= 0 && end > start);
  const block = http.slice(start, end);
  assert.match(block, /const apiRequest = \/\^\\\/api/);
  assert.match(block, /\|\| apiRequest/);
  assert.match(block, /cross-site-request-blocked/);
});

test('ASVS V14 authenticated/API responses are centrally marked no-store', () => {
  const http = read('lib/server/http-application.js');
  assert.match(http, /if \(isApiRequest\(req\)\) noStore\(res\)/);
  assert.match(http, /function noStore\(res\)[\s\S]*Cache-Control[\s\S]*no-store/);
});

test('ASVS V3 external OAuth navigation is user-mediated rather than an automatic open redirect', () => {
  const oauth = read('public/oauth-bridge.js');
  const start = oauth.indexOf('function go(url)');
  const end = oauth.indexOf('async function poll()', start);
  const block = oauth.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /parsed\.origin !== location\.origin/);
  assert.ok(block.indexOf('window.confirm(prompt)') < block.indexOf('location.replace(parsed.href)'));
  assert.match(block, /if \(!window\.confirm\(prompt\)\).*return/s);
});


test('ASVS V11 password and DATA_KEY scrypt parameters are explicit and pinned', () => {
  const auth = read('lib/auth-utils.js');
  const store = read('lib/server/state-store.js');
  for (const source of [auth, store]) {
    assert.match(source, /N:\s*16384/);
    assert.match(source, /r:\s*8/);
    assert.match(source, /p:\s*1/);
    assert.match(source, /maxmem:\s*64 \* 1024 \* 1024/);
  }
  assert.match(auth, /crypto\.scrypt\(String\(plain\), salt, keyLength, SCRYPT_OPTIONS,/);
  assert.match(auth, /crypto\.scryptSync\(String\(plain\), salt, 64, SCRYPT_OPTIONS\)/);
  assert.match(store, /crypto\.scryptSync\(secret, salt, 32, SCRYPT_OPTIONS\)/);
});

test('ASVS V11 L3 non-guessable link and recovery secrets have at least 128 bits of entropy', () => {
  const shares = read('lib/server/share-service.js');
  const settings = read('lib/server/settings-service.js');
  const accounts = read('lib/server/admin-account-routes.js');
  assert.match(shares, /const minimumBytes = ASVS_L3_MODE \? 16 : 12/);
  assert.match(settings, /clampNum\(body\.tokenBytes, ASVS_L3_MODE \? 16 : 12, 48, 24\)/);
  assert.match(accounts, /crypto\.randomBytes\(16\)\.toString\('hex'\).*128-bit recovery secrets/);
});

test('ASVS V4 generated HTTP framing does not set Transfer-Encoding and Content-Length derives from exact bytes or bounded file ranges', () => {
  const files = [
    'lib/server/download-service.js', 'lib/server/admin-share-routes.js',
    'lib/server/pwa-routes.js', 'lib/server/admin-photo-routes.js',
    'lib/server/audit-service.js', 'oauth-broker/server.js',
  ].map(read).join('\n');
  assert.doesNotMatch(files, /setHeader\(["']Transfer-Encoding["']/i);
  assert.match(files, /Content-Length['"],\s*end - start \+ 1/);
  assert.match(files, /Content-Length['"],\s*String\(st\.size\)/);
  assert.match(files, /['"]Content-Length['"]\s*:\s*String\(body\.length\)/);
  assert.match(files, /['"]Content-Length['"]\s*:\s*data\.length/);
});


test('ASVS V13 L3 diagnostics do not disclose backend component versions or host process details', () => {
  const health = read('lib/server/system-health-service.js');
  const storage = read('lib/server/admin-storage-routes.js');
  assert.match(health, /version:ASVS_L3_MODE \? null/);
  assert.match(health, /runtime:ASVS_L3_MODE[\s\S]*node:null[\s\S]*hostname:null[\s\S]*pid:null/);
  assert.match(storage, /version: ASVS_L3_MODE \? null/);
});

test('ASVS V16 audit records normalize authentication method and result metadata', () => {
  const audit = read('lib/server/audit-service.js');
  const auth = read('lib/server/auth-service.js');
  assert.match(audit, /authMethod: inferAuthenticationMethod\(action, opts\)/);
  assert.match(audit, /authResult: authenticationResult\(action\)/);
  assert.match(auth, /login-2fa-required/);
  assert.match(auth, /method:'recovery-code'/);
  assert.match(auth, /successfulAuthMethod/);
});
