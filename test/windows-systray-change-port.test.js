const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const nativeUi = fs.readFileSync(path.join(root, 'windows-launcher', 'NativeUi.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');

test('Windows systray can persist an exact port and request a supervised restart', () => {
  assert.match(launcher, /TrayChangePort/);
  assert.match(launcher, /ChangeServerPort\(\)/);
  assert.match(launcher, /PromptText\(/);
  assert.match(launcher, /SaveConfig\(\);[\s\S]{0,500}SignalServerHostReload\(\)/);
  assert.match(launcher, /requestedPort < 1 \|\| requestedPort > 65535/);
  assert.match(launcher, /IsTcpPortAvailable\(requestedPort\)/);
  assert.match(launcher, /previousPreference/);
  assert.match(launcher, /PortChangeFailed/);
});

test('Windows ServerHost honors exact configured ports while keeping legacy automatic fallback', () => {
  assert.match(host, /public int port\s*=\s*0;/);
  assert.match(host, /ChooseRuntimePort\(_config\.port\)/);
  assert.match(host, /if \(configuredPort > 0\)/);
  assert.match(host, /CanBindPort\(configuredPort\)/);
  assert.match(host, /for \(var port = Program\.DefaultPort; port <= Program\.MaxFallbackPort; port\+\+\)/);
  assert.match(host, /session\.port < 1 \|\| session\.port > 65535/);
});

test('native Windows launcher owns its numeric port input dialog without WinForms', () => {
  assert.match(nativeUi, /NativeTextInputDialog/);
  assert.match(nativeUi, /EsNumber = 0x2000/);
  assert.match(nativeUi, /GetWindowTextW/);
  assert.doesNotMatch(nativeUi, /System\.Windows\.Forms/);
});
