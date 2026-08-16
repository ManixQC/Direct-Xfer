'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const server = read('server.js');
const app = read('public','app.js');
const pwa = read('pwa','app.js');
const html = read('public','index.html');

test('security-sensitive global diagnostics and DLP quarantine are role-guarded', () => {
  assert.match(server, /adminRouter\.get\('\/dlp\/quarantine', requireAuditAccess,/);
  assert.match(server, /adminRouter\.delete\('\/dlp\/quarantine\/:id', requireFullAdmin,/);
  assert.match(server, /adminRouter\.get\('\/network', requireAuditAccess,/);
  assert.match(server, /adminRouter\.get\('\/network\/proxy-check', requireAuditAccess,/);
  assert.match(app, /async function loadNetwork\(\) \{[\s\S]*state\.role === 'operator'/);
});

test('PWA owner-event SSE revalidates its live principal and session invalidation closes session-only streams', () => {
  assert.match(server, /function pwaEventStreamValidator\(req\)/);
  assert.match(server, /function pwaEventStreamAuthorized\(res\)/);
  assert.match(server, /if \(!pwaEventStreamAuthorized\(res\)\) \{ dropPwaEventStream\(res\)/);
  assert.match(server, /res\.dxPwaSessionSid = \(!req\.pwaDevice/);
  assert.match(server, /function invalidateSessionSid\(sid\)[\s\S]*closePwaEventStreamsForSession\(sid\)/);
  assert.match(server, /const ping = setInterval\(\(\) => \{[\s\S]*if \(!validate\(\)\)/);
  assert.match(server, /const delivered = new Set\(\)/);
  assert.match(server, /if \(delivered\.has\(res\)\) continue/);
});

test('unique visitor quotas are bounded to the durable visitor-store ceiling', () => {
  assert.match(server, /const VISITORS_MAX = 20000/);
  assert.match(server, /function parseMaxVisitors\(v\)[\s\S]*Math\.min\(VISITORS_MAX, n\)/);
  assert.match(server, /function recordAndCheckVisitor\(s, req\) \{[\s\S]*const cap = parseMaxVisitors\(s\.maxVisitors\)/);
  assert.match(server, /const maxVisitors = parseMaxVisitors\(body\.maxVisitors\)/);
  assert.match(html, /id="opt-maxvisitors"[^>]*max="20000"/);
  assert.match(html, /id="edit-maxvisitors"[^>]*max="20000"/);
});

test('new audit actions are translated in both standard and PWA activity views', () => {
  for (const key of ['image-version-restored','passkey-device-removed']) {
    assert.ok(app.includes(key), `standard missing ${key}`);
    assert.ok(pwa.includes(key), `PWA missing ${key}`);
  }
});
