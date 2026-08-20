'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const app = read('public/app.js');
const server = read('server.js');
const dlp = require('../lib/dlp-utils');

test('standard DLP warning uses an in-app modal instead of native confirm', () => {
  const start = app.indexOf('function confirmDlpWarning(data)');
  const end = app.indexOf('function dlpCancelledError', start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  assert.match(block, /id:'dlp-warning-overlay'/);
  assert.match(block, /role:'dialog'/);
  assert.match(block, /t\('dlp\.publishAnyway'\)/);
  assert.match(block, /t\('dlp\.cancelWarning'\)/);
  assert.doesNotMatch(block, /window\.confirm|\bconfirm\(/);
});

test('DLP warn cancellation is not rendered as a creation failure', () => {
  assert.match(app, /throw dlpCancelledError\(e\.data\)/);
  assert.match(app, /function isDlpCancelled\(error\)/);
  assert.match(app, /if \(isDlpCancelled\(e\)\) \{ toast\(t\('dlp\.cancelled'\),'warn'\); return; \}/);
  assert.match(app, /if \(isDlpCancelled\(error\)\) \{ toast\(t\('dlp\.cancelled'\),'warn'\); return; \}/);
});

test('DLP warning reports both findings and incomplete analysis when both apply', () => {
  assert.match(app, /if \(d\.count\) parts\.push\(t\('dlp\.warningConfirm'/);
  assert.match(app, /else if \(d\.incomplete \|\| d\.filesSkipped/);
  assert.match(app, /parts\.push\(t\('dlp\.warningQuestion'\)\)/);
});

test('server gives generic DLP warnings an explicit reason and keeps the scan payload', () => {
  assert.match(server, /reason:scan\.count \? \(incomplete \? 'findings-and-incomplete' : 'findings'\) : 'incomplete-scan', dlp:scan/);
});

test('DLP summaries expose the configured per-file scan limit for a useful warning', () => {
  const summary = dlp.dlpPublicSummary({ findings:[], filesScanned:1, filesSkipped:1, maxBytes:8 * 1024 * 1024 });
  assert.equal(summary.incomplete, true);
  assert.equal(summary.filesSkipped, 1);
  assert.equal(summary.maxFileMB, 8);
});
