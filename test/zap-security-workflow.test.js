'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function fixture(alerts) {
  return {
    '@version': '2.17.0',
    site: [{ '@name': 'http://127.0.0.1:55750', alerts }],
  };
}

function runScript(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('ZAP SARIF exporter keeps Medium/High alerts and excludes Low/Info', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-zap-'));
  const input = path.join(dir, 'report.json');
  const output = path.join(dir, 'report.sarif');
  fs.writeFileSync(input, JSON.stringify(fixture([
    { pluginid: '10020', alert: 'Low header note', riskcode: '1', riskdesc: 'Low (Medium)', instances: [{ uri: 'http://127.0.0.1:55750/' }] },
    { pluginid: '40012', alert: 'Reflected XSS', riskcode: '3', riskdesc: 'High (High)', cweid: '79', solution: 'Encode output', instances: [{ uri: 'http://127.0.0.1:55750/test' }] },
    { pluginid: '10055', alertRef: '10055-6', alert: 'CSP style issue', riskcode: '2', riskdesc: 'Medium (High)', instances: [{ uri: 'http://127.0.0.1:55750/' }] },
    { pluginid: '20000', alert: 'Medium finding without instances', riskcode: '2', riskdesc: 'Medium (Medium)' },
  ])), 'utf8');
  const result = runScript('zap-report-to-sarif.js', [input, output]);
  assert.equal(result.status, 0, result.stderr);
  const sarif = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].automationDetails.id, 'owasp-zap/baseline/');
  assert.equal(sarif.runs[0].results.length, 3);
  assert.deepEqual(sarif.runs[0].results.map((x) => x.ruleId).sort(), ['zap/10055-6', 'zap/20000', 'zap/40012']);
  assert.equal(sarif.runs[0].results.find((x) => x.ruleId === 'zap/40012').level, 'error');
  assert.equal(sarif.runs[0].results.find((x) => x.ruleId === 'zap/10055-6').properties.zapPluginId, '10055');
  assert.equal(sarif.runs[0].results.find((x) => x.ruleId === 'zap/10055-6').properties.zapAlertRef, '10055-6');
  for (const finding of sarif.runs[0].results) {
    assert.equal(finding.locations.length, 1);
    assert.equal(finding.locations[0].physicalLocation.artifactLocation.uri, 'security/zap-dast-target.md');
    assert.equal(finding.locations[0].physicalLocation.region.startLine, 1);
  }
});

test('ZAP gate passes Low-only reports and fails Medium/High reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-zap-gate-'));
  const low = path.join(dir, 'low.json');
  const medium = path.join(dir, 'medium.json');
  fs.writeFileSync(low, JSON.stringify(fixture([{ pluginid: '1', alert: 'Low', riskcode: '1' }])), 'utf8');
  fs.writeFileSync(medium, JSON.stringify(fixture([{ pluginid: '2', alert: 'Medium', riskcode: '2', riskdesc: 'Medium (Medium)' }])), 'utf8');
  assert.equal(runScript('check-zap-report.js', [low]).status, 0);
  const blocked = runScript('check-zap-report.js', [medium]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /OWASP ZAP gate failed/);
});


test('ZAP workflow keeps shell blocks actionlint/ShellCheck-safe and validates SARIF locations', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'zap.yml'), 'utf8');
  assert.doesNotMatch(workflow, /export ADMIN_PASSWORD="\$\(/);
  assert.match(workflow, /ADMIN_PASSWORD="\$\(openssl rand -hex 32\)"\s+export ADMIN_PASSWORD/);
  assert.match(workflow, /for _ in \$\(seq 1 60\); do/);
  assert.doesNotMatch(workflow, /for attempt in \$\(seq 1 60\); do/);
  assert.match(workflow, /locations\[0\]\.physicalLocation\.artifactLocation\.uri == \"security\/zap-dast-target\.md\"/);
});



test('ZAP parsing fails closed on malformed thresholds, risk codes, and report structure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-zap-invalid-'));
  const valid = path.join(dir, 'valid.json');
  const malformedRisk = path.join(dir, 'malformed-risk.json');
  const malformedReport = path.join(dir, 'malformed-report.json');
  const emptySites = path.join(dir, 'empty-sites.json');
  const missingAlerts = path.join(dir, 'missing-alerts.json');
  fs.writeFileSync(valid, JSON.stringify(fixture([{ pluginid:'1', alert:'Low', riskcode:'1' }])), 'utf8');
  fs.writeFileSync(malformedRisk, JSON.stringify(fixture([{ pluginid:'2', alert:'Unknown', riskcode:'NaN' }])), 'utf8');
  fs.writeFileSync(malformedReport, JSON.stringify({ '@version':'2.17.0' }), 'utf8');
  fs.writeFileSync(emptySites, JSON.stringify({ '@version':'2.17.0', site:[] }), 'utf8');
  fs.writeFileSync(missingAlerts, JSON.stringify({ '@version':'2.17.0', site:[{ '@name':'http://127.0.0.1:55750' }] }), 'utf8');
  const badThreshold = runScript('check-zap-report.js', [valid], { ZAP_MIN_RISK:'banana' });
  assert.equal(badThreshold.status, 1);
  assert.match(badThreshold.stderr, /Invalid ZAP_MIN_RISK/);
  const badRisk = runScript('check-zap-report.js', [malformedRisk]);
  assert.equal(badRisk.status, 1);
  assert.match(badRisk.stderr, /Invalid or missing ZAP riskcode/);
  const badReport = runScript('check-zap-report.js', [malformedReport]);
  assert.equal(badReport.status, 1);
  assert.match(badReport.stderr, /missing site collection/);
  const emptyReport = runScript('check-zap-report.js', [emptySites]);
  assert.equal(emptyReport.status, 1);
  assert.match(emptyReport.stderr, /site collection is empty/);
  const missingAlertsReport = runScript('check-zap-report.js', [missingAlerts]);
  assert.equal(missingAlertsReport.status, 1);
  assert.match(missingAlertsReport.stderr, /missing alerts collection/);
});

test('strict script-src-attr CSP has no inline event-handler regression on public pages', () => {
  const pages = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'public-pages.js'), 'utf8');
  const mediaResume = fs.readFileSync(path.join(ROOT, 'public', 'media-resume.js'), 'utf8');
  assert.doesNotMatch(pages, /\son[a-z]+\s*=/i);
  assert.match(pages, /data-dx-video-fallback="1"/);
  assert.match(mediaResume, /addEventListener\('error'/);
  assert.match(mediaResume, /el\.error \|\| Number\(el\.networkState\) === 3/);
  assert.match(mediaResume, /querySelector\('\.vfallback'\)/);
});

test('ZAP rule identities cannot collide when normalization is required', () => {
  const { ruleIdentity } = require('../scripts/zap-report-utils');
  const a = ruleIdentity({ alertRef:'future/rule', pluginid:'1' });
  const b = ruleIdentity({ alertRef:'future rule', pluginid:'1' });
  assert.notEqual(a.safe, b.safe);
  assert.match(a.safe, /^future_rule-[0-9a-f]{12}$/);
  assert.match(b.safe, /^future_rule-[0-9a-f]{12}$/);
});

test('public page nonce injector preserves an existing nonce instead of duplicating it', () => {
  const pages = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'public-pages.js'), 'utf8');
  assert.match(pages, /<script\(\?!\[\^>\]\*\\bnonce\\s\*=/);
  assert.match(pages, /<style\(\?!\[\^>\]\*\\bnonce\\s\*=/);
});

test('public page nonce injection is idempotent at runtime', () => {
  const { createPublicPages } = require('../lib/server/public-pages');
  const pages = createPublicPages({
    APP_NAME:'Direct-Xfer', APP_VERSION:'1.71.42', APP_YEAR:'2026',
    requestContext:{ getStore:() => ({ cspNonce:'fresh-nonce' }) }, recipientByToken:new Map(),
    pubIp:(x) => x, linkPrefix:() => '/s/', shareEffectiveExpiry:() => 0,
    getSettings:() => ({}), clientIp:() => '127.0.0.1', parseCookies:() => ({}),
    receptionThreadEnabled:() => false, parseMaxVisitors:() => 0, zipAllowed:() => false,
    esc:(v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
    jsonForScript:JSON.stringify, formatBytes:String, encodePath:encodeURIComponent,
    previewInfo:() => null, subtitleTracksFor:() => [], renderKind:() => '', renderMarkdown:(x) => String(x),
  });
  const html = pages.pageShell('en', 'nonce test', '<style nonce="keep-me">a{}</style><style>b{}</style><script nonce="keep-script">1</script><script>2</script>');
  assert.match(html, /<style nonce="keep-me">a\{\}<\/style>/);
  assert.doesNotMatch(html, /<style nonce="fresh-nonce" nonce="keep-me">/);
  assert.match(html, /<style nonce="fresh-nonce">b\{\}<\/style>/);
  assert.match(html, /<script nonce="keep-script">1<\/script>/);
  assert.doesNotMatch(html, /<script nonce="fresh-nonce" nonce="keep-script">/);
  assert.match(html, /<script nonce="fresh-nonce">2<\/script>/);
});

test('ZAP CSP regression removes unsafe-inline from style-src while nonceing style elements', () => {
  const http = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'http-application.js'), 'utf8');
  const pages = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'public-pages.js'), 'utf8');
  assert.doesNotMatch(http, /style-src 'self' 'unsafe-inline'/);
  assert.match(http, /style-src 'self' 'nonce-\$\{cspNonce\}'/);
  assert.match(http, /style-src-elem 'self' 'nonce-\$\{cspNonce\}'/);
  assert.match(http, /style-src-attr 'unsafe-inline'/);
  assert.match(http, /script-src-attr 'none'/);
  assert.match(pages, /<style\$\{nonceAttr\}>\$\{publicStyleBlock\(\)\}<\/style>/);
  assert.match(pages, /<style\(\?!\[\^>\]\*\\bnonce\\s\*=/);
});
