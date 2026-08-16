'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const host = read('windows-server-host', 'Program.cs');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');
const iss = read('installer', 'Direct-Xfer.iss');

function normalizedTextSha256(rel) {
  const text = read(...rel.split('/')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('1.59.1 hardening remains present after the 1.62.2 ServerHost split', () => {
  assert.match(launcher, /AssemblyVersion\("1\.62\.2\.0"\)/);
  assert.match(host, /AssemblyVersion\("1\.62\.2\.0"\)/);
  assert.match(launcher, /RuntimeAppBuild = "1\.62\.2-launcher43-csharp"/);
  assert.match(host, /RuntimeAppBuild = "1\.62\.2-launcher43-csharp"/);
  assert.match(workflow, /DX_VERSION: '1\.62\.2'/);
  assert.match(iss, /#define AppVersion "1\.62\.2"/);
});

test('PWA cache generation is advanced consistently for 1.62.2', () => {
  for (const file of ['pwa/index.html', 'pwa/login.html', 'pwa/launch.html', 'pwa/app.js', 'pwa/login.js', 'pwa/sw.js']) {
    assert.doesNotMatch(read(...file.split('/')), /v=266|pwa280/);
  }
  assert.match(read('pwa', 'index.html'), /v=269/);
  assert.match(read('pwa', 'app.js'), /v=269/);
  assert.match(read('pwa', 'sw.js'), /v=269/);
});

test('launcher configuration writes remain atomic and recover their backup', () => {
  assert.match(launcher, /path \+ "\.tmp\." \+ Guid\.NewGuid\(\)\.ToString\("N"\)/);
  assert.match(launcher, /File\.Replace\(temp, path, backup, true\)/);
  assert.doesNotMatch(launcher, /File\.Delete\(path\);\s*File\.Move\(temp, path\)/);
  assert.match(launcher, /new\[\] \{ ConfigPath, ConfigPath \+ "\.bak" \}/);
  assert.match(launcher, /WriteTextAtomic\(ConfigPath, Json\.Serialize\(cfg\)\)/);
});

test('Node validation remains pinned, explicit and bounded inside ServerHost only', () => {
  assert.doesNotMatch(launcher, /node\.exe|DX_WINDOWS_NODE|NodeExeSha256|Process\.Kill\(/);
  const candidates = host.slice(host.indexOf('private static IEnumerable<string> NodeCandidates()'), host.indexOf('private string EnsureNode()'));
  assert.match(candidates, /yield return PortableNodePath/);
  assert.match(candidates, /Environment\.GetEnvironmentVariable\("DX_WINDOWS_NODE"\)/);
  assert.doesNotMatch(candidates, /ProgramFiles|FindOnPath/);
  assert.match(host, /DX_WINDOWS_NODE_SHA256/);
  assert.match(host, /if \(!process\.WaitForExit\(3000\)\)/);
  assert.match(host, /try \{ process\.Kill\(\); \} catch \{ \}/);
  assert.match(host, /NodeVersion = "24\.19\.0"/);
  assert.match(host, /NodeExeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"/);
  assert.match(host, /parsed\.Major == 20 \|\| parsed\.Major >= 22/);
});

test('stale saved session cannot target an unrelated process and launcher refuses orphaned host sessions', () => {
  assert.match(host, /public long serverStartedUtcTicks;/);
  assert.match(host, /serverStartedUtcTicks = GetProcessStartUtcTicks\(_server\)/);
  assert.match(host, /var sameStart = session\.serverStartedUtcTicks > 0/);
  assert.match(host, /GetProcessStartUtcTicks\(process\) == session\.serverStartedUtcTicks/);
  assert.match(host, /if \(sameExecutable && sameStart\)/);
  assert.match(launcher, /IsServerHostIpcAlive\(\)/);
  assert.match(launcher, /EventWaitHandle\.OpenExisting\(Program\.ServerHostReloadEventName\)/);
  assert.doesNotMatch(launcher, /Process\.GetProcessById|\.Kill\(\)/);
});

test('all ServerHost critical runtime hashes match actual normalized 1.62.2 files', () => {
  for (const rel of ['package.json','package-lock.json','server.js','public/app.js','pwa/app.js','node_modules/express/package.json']) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = host.match(new RegExp('\\{ "' + escaped + '", "([0-9a-f]{64})" \\}'));
    assert.ok(match, 'missing embedded hash for ' + rel);
    assert.equal(match[1], normalizedTextSha256(rel), 'hash mismatch for ' + rel);
  }
});

test('installer upgrade and GitHub release gates remain hardened', () => {
  assert.match(iss, /\[InstallDelete\]/);
  assert.match(iss, /Type: filesandordirs; Name: "\{app\}\\runtime\\app"/);
  assert.match(iss, /Type: filesandordirs; Name: "\{app\}\\runtime\\node"/);
  assert.match(iss, /Flags: nowait postinstall skipifsilent runasoriginaluser/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /name: Test release-critical changes/);
  assert.match(workflow, /recent-changes-ultra-audit-1\.62\.2\.test\.js/);
  assert.match(workflow, /windows-server-host-split-1\.59\.4\.test\.js/);
});

test('ServerHost has bounded startup readiness with diagnostics and clean cancellation', () => {
  assert.match(host, /StartupReadyTimeoutMs = 30000/);
  assert.match(host, /Stopwatch\.StartNew\(\)/);
  assert.match(host, /watch\.ElapsedMilliseconds < Program\.StartupReadyTimeoutMs/);
  assert.match(host, /server did not become ready before timeout/);
  assert.match(host, /startup cancelled by stop request/);
  assert.match(host, /WaitHandle\.WaitAny\(new WaitHandle\[\] \{ _stopEvent, _reloadEvent \}, 100\)/);
});
