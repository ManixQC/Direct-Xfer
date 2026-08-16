'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');

test('active sessions retain security metadata and can be revoked individually', () => {
  assert.match(server, /lastSeenAt:\s*authenticatedAt/);
  assert.match(server, /ip:\s*clientIp\(req\)/);
  assert.match(server, /ua:\s*String\(req\.headers\['user-agent'\]/);
  assert.match(server, /adminRouter\.get\('\/security\/overview'/);
  assert.match(server, /adminRouter\.delete\('\/security\/sessions\/:id'/);
  assert.match(server, /sessionPublicHandle\(sid\)/);
  assert.doesNotMatch(server, /sessions:\s*activeSessions[^\n]*sid:/);
});

test('security center UI lists sessions and recent signed security history', () => {
  assert.match(html, /id="security-btn"/);
  assert.match(html, /id="security-overlay"/);
  assert.match(html, /id="security-sessions"/);
  assert.match(html, /id="security-history"/);
  assert.match(app, /async function loadSecurityOverview/);
  assert.match(app, /\/api\/security\/overview/);
  assert.match(app, /\/api\/security\/sessions\//);
});

test('structured logs remain inside the HMAC-covered detail field and localize in UI', () => {
  assert.match(server, /function auditStructuredDetail\(code, params, fallback\)/);
  assert.match(server, /'@dxlog:' \+ JSON\.stringify/);
  assert.match(server, /opts\.detail && typeof opts\.detail === 'object'/);
  assert.match(server, /detail:\s*detailValue/);
  assert.match(app, /raw\.startsWith\('@dxlog:'\)/);
  assert.match(app, /'log\.session-revoked'/);
  assert.match(app, /'log\.dlp-result'/);
  assert.match(app, /'log\.diagnostics-run'/);
});

test('DLP explanations persist only redacted findings and expose a detail UI', () => {
  assert.match(server, /findings:Array\.isArray\(scan\.findings\)/);
  assert.match(server, /sample:String\(f\.sample\|\|''\)\.slice\(0,80\)/);
  assert.match(html, /id="dlp-details-overlay"/);
  assert.match(app, /function showDlpDetails\(/);
  assert.match(app, /function dlpFindingLines\(/);
  assert.match(pwa, /function pwaDlpFindingLines\(/);
});

test('reverse proxy diagnostics cover forwarded identity, public base, SSE and upload requirements', () => {
  for (const code of ['no-forwarded-host','base-host-mismatch','base-proto-mismatch','base-port-mismatch','no-client-ip-header','sse-streaming','buffering']) {
    assert.ok(server.includes(`'${code}'`), `missing proxy check ${code}`);
  }
  assert.match(server, /expectedBase:/);
  assert.match(server, /httpVersion:req\.httpVersion/);
  assert.match(app, /proxy\.msg\.sse-streaming/);
});

test('TLS diagnostics expose certificate identity, validity, trust and safe fixes', () => {
  assert.match(server, /function tlsCertificateDiagnostics\(\)/);
  for (const field of ['subject','issuer','sans','validFrom','validTo','fingerprint','publicKeyBits','minProtocol']) {
    assert.ok(server.includes(field), `missing TLS field ${field}`);
  }
  assert.match(server, /action:'tls-refresh'/);
  assert.match(server, /action:'search-reindex'/);
  assert.match(server, /adminRouter\.post\('\/diagnostics\/fix'/);
  assert.match(app, /'diag\.fix':'Corriger'/);
});

test('PWA build/cache was advanced to deliver DLP explanation changes', () => {
  assert.match(pwa, /2026\.08\.16-pwa308/);
  assert.match(sw, /2026\.08\.16-pwa308/);
  assert.match(sw, /\/app\/app\.js\?v=290/);
});
