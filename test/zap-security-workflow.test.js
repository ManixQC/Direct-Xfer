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
  ])), 'utf8');
  const result = runScript('zap-report-to-sarif.js', [input, output]);
  assert.equal(result.status, 0, result.stderr);
  const sarif = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].automationDetails.id, 'owasp-zap/baseline/');
  assert.equal(sarif.runs[0].results.length, 2);
  assert.deepEqual(sarif.runs[0].results.map((x) => x.ruleId).sort(), ['zap/10038', 'zap/40012']);
  assert.equal(sarif.runs[0].results.find((x) => x.ruleId === 'zap/40012').level, 'error');
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
