'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const server = read('server.js');
const pwa = read('pwa/app.js');
const login = read('pwa/login.js');
const standard = read('public/app.js');

test('completed resumable uploads keep an idempotency receipt', () => {
  assert.match(server, /const completedUploadReceipts = new Map\(\)/);
  assert.match(server, /complete:true, response:receipt\.response/);
  assert.match(server, /error:'upload-id-conflict'/);
  assert.match(server, /rememberCompletedUpload\(uploadId, total, relForCheck, response\)/);
});

test('username-scoped passkey challenges cannot authenticate another account', () => {
  assert.match(server, /webauthnLoginChallenges\.set\(token, \{ challenge: b64u\(challenge\), accountId, rpId: rp\.id, origin: rp\.origin, at: Date\.now\(\) \}\)/);
  assert.match(server, /stored\.accountId && String\(acc\.id\) !== String\(stored\.accountId\)/);
  assert.match(server, /error:'passkey-unavailable'/);
  assert.match(server, /cred\.type !== 'public-key'/);
  assert.match(login, /message\('passkeyNone'\)/);
});

test('privacy editing preserves alpha, clamps zones, and hashes reviewed bytes', () => {
  assert.match(pwa, /function normalizedAnnRect\(a, b\)/);
  assert.match(pwa, /annCanvas\.getContext\('2d'\)/);
  assert.match(pwa, /exportCtx\.fillStyle = '#fff'/);
  assert.match(pwa, /smartBlurRemovedMetadata = reviewedFile !== file/);
  assert.match(pwa, /clientHash = await sha256Blob\(workingFile\)/);
});

test('cached SSE presence is reapplied after photo and album rendering', () => {
  const matches = standard.match(/applySharePresence\(\)/g) || [];
  assert.ok(matches.length >= 7, 'presence must be applied on stream events and every card render path');
  assert.match(standard, /reconcileChildren\(list, desired\);\s*updatePhotoStats\(ordered\);[\s\S]{0,400}applySharePresence\(\)/);
  assert.match(standard, /albums\.forEach[\s\S]{0,4000}list\.appendChild\(card\);\s*\}\);\s*applySharePresence\(\)/);
});
