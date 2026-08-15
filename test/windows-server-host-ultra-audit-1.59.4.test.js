'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const host = read('windows-server-host', 'Program.cs');
const launcher = read('windows-launcher', 'Program.cs');
const server = read('server.js');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');

function normalizedSha(relative) {
  const text = read(...relative.split('/')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('1.60.0 Windows server metadata is synchronized', () => {
  assert.match(host, /AppVersion = "1\.60\.0"/);
  assert.match(host, /RuntimeAppBuild = "1\.60\.0-launcher35-csharp"/);
  assert.match(host, /HostVersion = "1\.60\.0-serverhost8-csharp"/);
  assert.match(launcher, /RuntimeAppBuild = "1\.60\.0-launcher35-csharp"/);
  assert.match(launcher, /ServerHostBuild = "1\.60\.0-serverhost8-csharp"/);
  assert.match(workflow, /DX_VERSION: '1\.60\.0'/);
  assert.match(workflow, /DX_SERVER_HOST_BUILD: '1\.60\.0-serverhost8-csharp'/);
});

test('startup timeout is recoverable and no longer marks the ServerHost as intentionally stopped', () => {
  assert.match(host, /server did not become ready before timeout; the supervised backend will be restarted/);
  const timeoutBlock = host.match(/if \(!WaitUntilReady\(\)\)[\s\S]*?return 1;\s*\}/);
  assert.ok(timeoutBlock, 'startup-timeout block should exist');
  assert.doesNotMatch(timeoutBlock[0], /_expectedStop\s*=\s*true/);
});

test('a living but unresponsive Node backend is restarted after bounded readiness probe failures', () => {
  assert.match(host, /HealthProbeIntervalMs = 5000/);
  assert.match(host, /HealthProbeFailureThreshold = 3/);
  assert.match(host, /consecutiveHealthFailures/);
  assert.match(host, /backend is alive but unresponsive; restarting supervised Node\.js process/);
  assert.match(host, /TryReady\(_port, _token, _scheme, _server\.Id, out usedScheme\)/);
});

test('configuration recovery validates absolute writable folders and repairs the primary file from backup', () => {
  assert.match(host, /foreach \(var candidate in new\[\] \{ ConfigPath, ConfigPath \+ "\.bak" \}\)/);
  assert.match(host, /NormalizeAndValidateConfig\(cfg\)/);
  assert.match(host, /Path\.IsPathRooted\(full\)/);
  assert.match(host, /ProbeDirectoryWritable\(path\)/);
  assert.match(host, /RestorePrimaryConfigAtomic\(cfg\)/);
  assert.match(host, /restored launcher-config\.json from the validated backup/);
});

test('initial configuration failures are diagnosable without unbounded emergency log growth', () => {
  assert.match(host, /waiting for a usable launcher configuration/);
  assert.match(host, /DateTime\.UtcNow\.AddSeconds\(30\)/);
  assert.match(host, /EmergencyLogMaxBytes = 2L \* 1024 \* 1024/);
  assert.match(host, /RotateLog\(path, Program\.EmergencyLogMaxBytes\)/);
});

test('Node launch removes inherited environment variables that can inject code or weaken TLS', () => {
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE']) {
    assert.match(host, new RegExp('"' + name + '"'));
  }
  assert.match(host, /SanitizeNodeEnvironment\(process\.StartInfo\)/);
  assert.match(host, /SanitizeNodeEnvironment\(start\)/);
  assert.match(host, /start\.EnvironmentVariables\.Remove\(inheritedName\)/);
});

test('saved host sessions are bounded and structurally validated before recovery', () => {
  assert.match(host, /info\.Length <= 0 \|\| info\.Length > 64 \* 1024/);
  assert.match(host, /session\.port < Program\.DefaultPort \|\| session\.port > Program\.MaxFallbackPort/);
  assert.match(host, /session\.token\.Length != 48 \|\| !session\.token\.All\(IsHexDigit\)/);
  assert.match(host, /Path\.IsPathRooted\(session\.nodePath\)/);
  assert.match(host, /Path\.IsPathRooted\(session\.hostPath\)/);
});

test('readiness parsing validates JSON app identity and exact PID rather than substring matching', () => {
  assert.match(host, /Json\.Deserialize<Dictionary<string, object>>\(body\)/);
  assert.match(host, /string\.Equals\(app, "Direct-Xfer", StringComparison\.Ordinal\) && pid == expectedPid/);
  assert.doesNotMatch(host, /body\.Contains\("\\\"ok\\\":true"\)/);
});

test('private ready and shutdown routes are loopback-only as well as token authenticated', () => {
  const ready = server.match(/app\.get\('\/__dx_launcher\/ready'[\s\S]*?\n\}\);/);
  const shutdown = server.match(/app\.post\('\/__dx_launcher\/shutdown'[\s\S]*?\n\}\);/);
  assert.ok(ready && shutdown);
  assert.match(ready[0], /windowsLauncherTokenMatches\(req\)/);
  assert.match(shutdown[0], /windowsLauncherTokenMatches\(req\)/);
  assert.match(shutdown[0], /Cache-Control', 'no-store/);
});

test('all ServerHost critical runtime hashes match the exact normalized 1.60.0 runtime files', () => {
  for (const relative of ['package.json','package-lock.json','server.js','public/app.js','pwa/app.js','node_modules/express/package.json']) {
    const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = host.match(new RegExp('\\{ "' + escaped + '", "([0-9a-f]{64})" \\}'));
    assert.ok(match, `missing hardcoded hash for ${relative}`);
    assert.equal(match[1], normalizedSha(relative), `runtime hash mismatch for ${relative}`);
  }
});
