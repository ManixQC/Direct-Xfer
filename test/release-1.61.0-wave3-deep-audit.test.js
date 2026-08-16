'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const server = read('server.js');
const publicApp = read('public', 'app.js');
const pwaApp = read('pwa', 'app.js');
const serverHost = read('windows-server-host', 'Program.cs');
const dlp = require('../lib/dlp-utils');

function loadPwaDlp() {
  const src = read('pwa', 'dlp-local.js');
  const sandbox = { self:{}, globalThis:{}, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Blob, File:global.File };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename:'pwa/dlp-local.js' });
  return sandbox.DirectXferDlp;
}

test('structured audit records stay bounded without truncating serialized JSON', () => {
  assert.match(server, /Never truncate the serialized JSON itself/);
  assert.doesNotMatch(server, /encoded\.slice\s*\(\s*0\s*,\s*300\s*\)/);
  assert.match(server, /payload\.truncated\s*=\s*true/);
  assert.match(server, /delete payload\.params\[keys\.pop\(\)\]/);
});

test('PWA activity understands the same structured @dxlog payloads as standard UI', () => {
  assert.match(publicApp, /raw\.startsWith\('@dxlog:'\)/);
  assert.match(pwaApp, /function pwaStructuredLogText\(raw\)/);
  assert.match(publicApp, /function localizedStructuredLogParams\(code,params\)/);
  assert.match(pwaApp, /function pwaStructuredLogParams\(code, params\)/);
  assert.match(pwaApp, /JSON\.parse\(String\(raw\)\.slice\(7\)\)/);
  for (const code of ['session-revoked','dlp-result','diagnostics-run','diagnostic-fix-requested','diagnostic-fix','diagnostic-fix-failed']) {
    assert.ok(pwaApp.includes(`'${code}'`), `missing PWA structured log template ${code}`);
  }
});

test('DLP excerpts reveal at most a tiny recognition fragment for short identifiers', () => {
  assert.equal(dlp.dlpRedact('123456789'), '12…89');
  assert.equal(dlp.dlpRedact('4111111111111111'), '41…11');
  assert.equal(dlp.dlpRedact('12345678'), '1…8');
  assert.equal(dlp.dlpRedact('1234'), '1…');
  assert.ok(!dlp.dlpRedact('123456789').includes('34567'));
});

test('PWA local DLP uses the same stronger redaction policy and a bumped engine version', () => {
  const engine = loadPwaDlp();
  assert.ok(engine);
  assert.equal(String(engine.version), '4');
  assert.equal(engine.redact('123456789'), '12…89');
  assert.equal(engine.redact('4111111111111111'), '41…11');
});

test('DLP reasons are localized in both standard and PWA interfaces', () => {
  assert.match(publicApp, /function dlpRuleReason\(f\)/);
  assert.match(pwaApp, /function pwaDlpRuleReason\(f\)/);
  for (const key of ['canadian-sin','payment-card','private-key','password','api-secret']) {
    assert.ok(publicApp.includes(`dlp.reason.${key}`), `missing standard DLP reason ${key}`);
    assert.ok(pwaApp.includes(`'${key}'`), `missing PWA DLP reason ${key}`);
  }
});

test('expired sessions are pruned during login and security overview', () => {
  assert.match(server, /function pruneDeadSessions\(now = Date\.now\(\)\)/);
  assert.match(server, /function createSession[\s\S]*?pruneDeadSessions\(\)/);
  assert.match(server, /adminRouter\.get\('\/security\/overview'[\s\S]*?pruneDeadSessions\(\)/);
});

test('session revocation is audit-first so a failed signed audit cannot silently revoke the session', () => {
  const route = server.match(/adminRouter\.delete\('\/security\/sessions\/:id'[\s\S]*?\n\}\);/);
  assert.ok(route, 'security session revoke route missing');
  const text = route[0];
  assert.ok(text.indexOf("auditReq(req, 'session-revoked'") < text.indexOf('invalidateSessionSid(foundSid)'));
  assert.match(text, /audit-write-failed/);
});

test('TLS diagnostics distinguish the active context from disk material and validate complete pairs', () => {
  assert.match(server, /activeTlsLeafPem/);
  assert.match(server, /disk-material-invalid-active-context-kept/);
  assert.match(server, /disk-material-pending-reload/);
  assert.match(server, /materialFingerprint[\s\S]*activeProvidedTlsMaterialFingerprint/);
  assert.match(server, /tls\.createSecureContext\(\{ cert:diskCert, key:diskKey/);
  assert.match(server, /signedByActiveCa/);
  assert.match(server, /Commit observable live-context metadata only after setSecureContext succeeds/);
});

test('TLS automatic fix is offered only when the current diagnostic says it is fixable', () => {
  assert.match(server, /check\.id === 'tls-certificate'[\s\S]*check\.fixable === true/);
  assert.match(server, /return res\.status\(409\)\.json\(\{ error:'not-fixable'/);
  assert.match(server, /const resolved = after\.status === 'ok'/);
  assert.match(server, /fix-not-resolved/);
});


test('automatic diagnostic fixes write signed intent before mutating state', () => {
  const start = server.indexOf("adminRouter.post('/diagnostics/fix'");
  const end = server.indexOf("adminRouter.get('/network'", start);
  assert.ok(start >= 0 && end > start, 'diagnostic fix route missing');
  const text = server.slice(start, end);
  assert.match(text, /diagnostic-fix-requested/);
  assert.match(text, /audit-write-failed/);
  assert.ok(text.indexOf("auditReq(req, 'diagnostic-fix-requested'") < text.indexOf('scheduleSearchReindex()'));
  const tlsPart = text.slice(text.indexOf("if (action === 'tls-refresh')"));
  assert.ok(tlsPart.indexOf("auditReq(req, 'diagnostic-fix-requested'") < tlsPart.indexOf('refreshLocalTlsServerContext'));
});

test('generic X-Forwarded-Server no longer identifies every reverse proxy as Traefik', () => {
  assert.match(server, /\/traefik\/i\.test\(headers\['x-forwarded-server'\]/);
  assert.match(server, /Reverse proxy \('/);
  assert.doesNotMatch(server, /else if \(headers\['x-forwarded-server'\]\) detectedProxy = 'Traefik'/);
});

test('Windows ServerHost integrity set covers both DLP engines', () => {
  assert.match(serverHost, /\{\s*"lib\/dlp-utils\.js"\s*,\s*"[0-9a-f]{64}"\s*\}/i);
  assert.match(serverHost, /\{\s*"pwa\/dlp-local\.js"\s*,\s*"[0-9a-f]{64}"\s*\}/i);
});
