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
    { pluginid: '10038', alert: 'CSP issue', riskcode: '2', riskdesc: 'Medium (High)', instances: [{ uri: 'http://127.0.0.1:55750/' }] },
    { pluginid: '20000', alert: 'Medium finding without instances', riskcode: '2', riskdesc: 'Medium (Medium)' },
  ])), 'utf8');
  const result = runScript('zap-report-to-sarif.js', [input, output]);
  assert.equal(result.status, 0, result.stderr);
  const sarif = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].automationDetails.id, 'owasp-zap/baseline/');
  assert.equal(sarif.runs[0].results.length, 3);
  assert.deepEqual(sarif.runs[0].results.map((x) => x.ruleId).sort(), ['zap/10038', 'zap/20000', 'zap/40012']);
  assert.equal(sarif.runs[0].results.find((x) => x.ruleId === 'zap/40012').level, 'error');
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


test('ZAP CSP regression removes unsafe-inline from style-src while nonceing style elements', () => {
  const http = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'http-application.js'), 'utf8');
  const pages = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'public-pages.js'), 'utf8');
  assert.doesNotMatch(http, /style-src 'self' 'unsafe-inline'/);
  assert.match(http, /style-src 'self' 'nonce-\$\{cspNonce\}'/);
  assert.match(http, /style-src-elem 'self' 'nonce-\$\{cspNonce\}'/);
  assert.match(http, /style-src-attr 'unsafe-inline'/);
  assert.match(http, /script-src-attr 'none'/);
  assert.match(pages, /<style\$\{nonceAttr\}>\$\{publicStyleBlock\(\)\}<\/style>/);
  assert.match(pages, /\.replace\(\/<style\(\?=\[\\s>\]\)\/g, `<style\$\{nonceAttr\}`\)/);
});

test('ZAP SARIF keeps distinct alertRef identities within one plugin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-zap-alertref-'));
  const input = path.join(dir, 'report.json');
  const output = path.join(dir, 'report.sarif');
  fs.writeFileSync(input, JSON.stringify(fixture([
    { pluginid: '10055', alertRef: '10055-5', alert: 'CSP script-src unsafe-inline', riskcode: '2', riskdesc: 'Medium (High)', instances: [{ uri: 'http://127.0.0.1:55750/' }] },
    { pluginid: '10055', alertRef: '10055-6', alert: 'CSP style-src unsafe-inline', riskcode: '2', riskdesc: 'Medium (High)', instances: [{ uri: 'http://127.0.0.1:55750/' }] },
  ])), 'utf8');
  const result = runScript('zap-report-to-sarif.js', [input, output]);
  assert.equal(result.status, 0, result.stderr);
  const sarif = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(sarif.runs[0].results.map((x) => x.ruleId).sort(), ['zap/10055-5', 'zap/10055-6']);
  assert.equal(sarif.runs[0].tool.driver.rules.length, 2);
  assert.equal(sarif.runs[0].results[0].properties.zapPluginId, '10055');
  assert.match(sarif.runs[0].results[0].properties.zapAlertRef, /^10055-[56]$/);
});

test('strict CSP does not leave blocked public inline handlers or OAuth unsafe-inline styles', () => {
  const pages = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'public-pages.js'), 'utf8');
  assert.doesNotMatch(pages, /\sonerror=/i);
  assert.match(pages, /data-dx-video-fallback/);
  assert.match(pages, /addEventListener\('error'/);
  for (const rel of [
    'oauth-broker/server.js',
    'oauth-broker/cloudflare-worker/src/index.js',
    'lib/assets/oauth-broker-worker.mjs',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(source, /style-src 'unsafe-inline'/);
    assert.doesNotMatch(source, /<body style=/);
    assert.match(source, /style-src 'nonce-\$\{nonce\}'/);
    assert.match(source, /style-src-attr 'none'/);
  }
});
