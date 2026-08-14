'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');
const iss = read('installer', 'Direct-Xfer.iss');

function normalizedTextSha256(rel) {
  const text = read(...rel.split('/')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('1.59.0 release metadata is synchronized across Node, PWA, C# and installer', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.0');
  assert.equal(lock.version, '1.59.0');
  assert.equal(lock.packages[''].version, '1.59.0');
  assert.match(read('pwa', 'app.js'), /APP_VERSION = '1\.59\.0'/);
  assert.match(read('pwa', 'app.js'), /APP_BUILD = '2026\.08\.14-pwa279'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.14-pwa279'/);
  assert.match(read('pwa', 'index.html'), /v1\.59\.0 · pwa279/);
  assert.match(launcher, /const string AppVersion = "1\.59\.0"/);
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.0-launcher26-csharp"/);
  assert.match(workflow, /DX_VERSION: '1\.59\.0'/);
  assert.match(workflow, /DX_RUNTIME_BUILD: '1\.59\.0-launcher26-csharp'/);
  assert.match(iss, /#define AppVersion "1\.59\.0"/);
});

test('PWA cache generation is advanced consistently for 1.59.0', () => {
  for (const file of ['pwa/index.html', 'pwa/login.html', 'pwa/launch.html', 'pwa/app.js', 'pwa/login.js', 'pwa/sw.js']) {
    assert.doesNotMatch(read(...file.split('/')), /v=264|pwa278/);
  }
  assert.match(read('pwa', 'index.html'), /v=265/);
  assert.match(read('pwa', 'app.js'), /v=265/);
  assert.match(read('pwa', 'sw.js'), /v=265/);
});

test('launcher configuration writes use a unique temp and atomic replace instead of delete-then-move', () => {
  assert.match(launcher, /path \+ "\.tmp-" \+ Guid\.NewGuid\(\)\.ToString\("N"\)/);
  assert.match(launcher, /File\.Replace\(temp, path, backup, true\)/);
  assert.doesNotMatch(launcher, /File\.Delete\(path\);\s*File\.Move\(temp, path\)/);
  assert.match(launcher, /finally\s*\{\s*try \{ if \(File\.Exists\(temp\)\) File\.Delete\(temp\); \} catch \{ \}\s*\}/s);
});

test('bundled hash-pinned Node.js is preferred and version probing has a hard timeout', () => {
  const listStart = launcher.indexOf('var raw = new List<string>');
  const portable = launcher.indexOf('PortableNodePath', listStart);
  const override = launcher.indexOf('Environment.GetEnvironmentVariable("DX_WINDOWS_NODE")', listStart);
  assert.ok(listStart >= 0 && portable > listStart && override > portable);
  assert.match(launcher, /ReadToEndAsync\(\)/);
  assert.match(launcher, /if \(!process\.WaitForExit\(3000\)\)/);
  assert.match(launcher, /try \{ process\.Kill\(\); \} catch \{ \}/);
  assert.match(launcher, /return process\.ExitCode == 0/);
});

test('stale saved session cannot kill an unrelated Node process after PID reuse', () => {
  assert.match(launcher, /public long startedUtcTicks;/);
  assert.match(launcher, /startedUtcTicks = GetProcessStartUtcTicks\(_server\)/);
  assert.match(launcher, /var sameStart = session\.startedUtcTicks > 0/);
  assert.match(launcher, /GetProcessStartUtcTicks\(process\) == session\.startedUtcTicks/);
  assert.match(launcher, /if \(sameExecutable && sameStart\)/);
});

test('installer post-install launch is explicitly de-elevated to the original user', () => {
  assert.match(iss, /Flags: nowait postinstall skipifsilent runasoriginaluser/);
  assert.match(iss, /PrivilegesRequired=admin/);
});

test('GitHub workflow has one release source of truth for artifact names and reproducible build Node', () => {
  assert.match(workflow, /node-version: '24\.19\.0'/);
  assert.match(workflow, /name: Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}/);
  assert.match(workflow, /Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}\.exe/);
  assert.match(workflow, /name: Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp/);
  assert.match(workflow, /path: dist\/Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp\//);
  assert.doesNotMatch(workflow, /name: Direct-Xfer-Setup-1\.59\.0/);
});

test('all launcher critical runtime hashes match the actual normalized 1.59.0 source files', () => {
  const files = [
    'package.json',
    'package-lock.json',
    'server.js',
    'public/app.js',
    'pwa/app.js',
    'node_modules/express/package.json'
  ];
  for (const rel of files) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = launcher.match(new RegExp('\\{ "' + escaped + '", "([0-9a-f]{64})" \\}'));
    assert.ok(match, 'missing embedded hash for ' + rel);
    assert.equal(match[1], normalizedTextSha256(rel), 'hash mismatch for ' + rel);
  }
});


test('Node compatibility contract matches the current production dependency floor', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.engines.node, '20 || >=22');
  assert.equal(lock.packages[''].engines.node, '20 || >=22');
  assert.match(launcher, /major == 20 \|\| major >= 22/);
  assert.doesNotMatch(launcher, /major >= 18/);
});


test('installer upgrades purge immutable runtime trees before copying the new release', () => {
  const iss = read('installer', 'Direct-Xfer.iss');
  assert.match(iss, /\[InstallDelete\]/);
  assert.match(iss, /Type: filesandordirs; Name: "\{app\}\\runtime\\app"/);
  assert.match(iss, /Type: filesandordirs; Name: "\{app\}\\runtime\\node"/);
  assert.doesNotMatch(iss, /InstallDelete[^]*LocalAppData/i);
});


test('launcher has a bounded 30-second startup readiness timeout with visible diagnostics', () => {
  assert.match(launcher, /StartupReadyTimeoutMs = 30000/);
  assert.match(launcher, /Stopwatch\.StartNew\(\)/);
  assert.match(launcher, /readyWait\.ElapsedMilliseconds < Program\.StartupReadyTimeoutMs/);
  assert.match(launcher, /live-but-never-ready child/);
  assert.match(launcher, /TailFile\(_runtimeLogPath, 4096\)/);
  assert.match(launcher, /MessageBox\.Show\(body, Tr\.AppTitle/);
  assert.match(launcher, /RequestExit\(\)/);
});


test('Windows release workflow blocks high or critical production npm advisories', () => {
  const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');
  assert.match(workflow, /name: Audit production dependencies/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.doesNotMatch(workflow, /Audit production dependencies[^]*continue-on-error:\s*true/);
});


test('GitHub Windows release build is gated by the latest regression suite', () => {
  const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');
  const gate = workflow.slice(workflow.indexOf('name: Test release-critical changes'), workflow.indexOf('name: Build C# launcher'));
  assert.match(gate, /release-1\.58\.3-picker-ten-rows\.test\.js/);
  assert.match(gate, /windows-csharp-runtime-layout-1\.58\.4\.test\.js/);
  assert.match(gate, /windows-inno-installer-1\.58\.4\.test\.js/);
  assert.match(gate, /windows-password-copy-history-tooltip-1\.58\.4\.test\.js/);
  assert.match(gate, /recent-changes-ultra-audit-1\.59\.0\.test\.js/);
});


test('launcher recovers a valid atomic config backup before treating startup as first-run', () => {
  assert.match(launcher, /new\[\] \{ ConfigPath, ConfigPath \+ "\.bak" \}/);
  assert.match(launcher, /first valid copy, heal the primary file/);
  assert.match(launcher, /WriteTextAtomic\(ConfigPath, Json\.Serialize\(cfg\)\)/);
  const loadStart = launcher.indexOf('private static LauncherConfig LoadConfig');
  const saveStart = launcher.indexOf('private void SaveConfig', loadStart);
  const load = launcher.slice(loadStart, saveStart);
  assert.match(load, /exists = true;/);
  assert.match(load, /exists = false;\s*return fallback;/);
});
