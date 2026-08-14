'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');

test('fatal runtime failures initiate bounded non-zero shutdown', () => {
  assert.match(server, /requestFatalShutdown\('unhandled-rejection'/);
  assert.match(server, /requestFatalShutdown\('uncaught-exception'/);
  assert.match(server, /shutdown\(kind, 1\)/);
  assert.match(server, /shutdown\('server-error', 1\)/);
  assert.match(server, /if \(desiredExitCode === 0\) \{[\s\S]*noteCenterCleanShutdown/);
});

test('clean Windows marker is written only after final persistence succeeds', () => {
  const flushPos = server.indexOf('const flushResult = await settleWithin(flushNow(), 900)');
  const markerPos = server.indexOf('if (exitCode === 0) markWindowsCleanShutdown(signal)');
  assert.ok(flushPos >= 0 && markerPos > flushPos);
  assert.match(server, /final persistence did not complete cleanly/);
});

test('shutdown hard deadline remains referenced and cannot disappear with an empty event loop', () => {
  const hard = server.slice(server.indexOf('// Absolute process bound.'), server.indexOf('// Auto-shutdown:'));
  assert.match(hard, /setTimeout\(\(\) => \{/);
  assert.doesNotMatch(hard, /hardExitTimer\.unref|timer\.unref/);
});

test('portable runtime is transparent sidecar content and integrity checked', () => {
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.0-launcher26-csharp"/);
  assert.match(launcher, /\.dx-runtime-build/);
  assert.match(launcher, /TryValidateApplicationRuntime\(candidate, out reason\)/);
  assert.match(launcher, /CriticalRuntimeSha256/);
  assert.match(launcher, /node_modules.*express/);
  assert.doesNotMatch(launcher, /MkdirTemp|extractZip|direct-xfer-app\.zip/);
});

test('portable launcher rejects unsupported or broken Node runtimes and validates health identity', () => {
  assert.match(launcher, /NodeUsable\(string path\)/);
  assert.match(launcher, /major == 20 \|\| major >= 22/);
  assert.match(launcher, /NodeExeSha256/);
  assert.match(launcher, /response\.StatusCode/);
  assert.match(launcher, /__dx_launcher\/ready/);
  assert.match(launcher, /X-Direct-Xfer-Launcher-Token/);
  assert.match(launcher, /expectedPid/);
});

test('download routes never send a second error after requireActiveShare already answered', () => {
  const lines = server.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('requireActiveShare(req, res')) continue;
    const nearby = lines.slice(i + 1, i + 5).join('\n');
    assert.doesNotMatch(nearby, /if \(!s \|\|[^\n]*sendError/, `double-send guard near line ${i + 1}`);
  }
});
