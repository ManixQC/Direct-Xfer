'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');
const launcherProject = read('windows-launcher/DirectXfer.Launcher.csproj');
const workflow = read('.github/workflows/build-windows-csharp.yml');

test('stable launcher discovers app release and runtime build from the installed payload', () => {
  assert.match(launcher, /internal const string LauncherVersion = "1\.70\.1"/);
  assert.match(launcher, /internal const string LauncherBuild = "launcher149-csharp"/);
  assert.match(launcher, /internal static string AppVersion[\s\S]{0,900}?RuntimeAppDirectory[\s\S]{0,900}?package\.json/);
  assert.match(launcher, /internal static string RuntimeBuild[\s\S]{0,700}?runtime-build\.txt/);
  assert.doesNotMatch(launcher, /internal const string AppVersion\s*=/);
  assert.doesNotMatch(launcher, /RuntimeAppBuild\s*=/);
  assert.match(launcherProject, /Component version: do not bump for app-only Direct-Xfer releases/);
});

test('launcher attachment negotiates stable protocols and payload identity rather than a compiled host build', () => {
  assert.match(launcher, /RuntimeProtocol = "1"/);
  assert.match(launcher, /ServerHostProtocol = "1"/);
  assert.match(launcher, /session\.runtimeProtocol, Program\.RuntimeProtocol/);
  assert.match(launcher, /session\.runtimeBuild, expectedRuntimeBuild/);
  assert.match(launcher, /session\.appVersion, expectedAppVersion/);
  assert.match(launcher, /session\.hostProtocol, Program\.ServerHostProtocol/);
  assert.doesNotMatch(launcher, /session\.hostBuild, Program\.ServerHostBuild/);
});

test('ServerHost publishes runtime-discovered identity with independent component build', () => {
  assert.match(host, /ServerHostBuild = "serverhost142-csharp"/);
  assert.match(host, /ExpectedRuntimeBuild = "runtime169"/);
  assert.match(host, /markerValue, Program\.ExpectedRuntimeBuild/);
  assert.match(host, /value, Program\.ExpectedRuntimeBuild/);
  assert.match(host, /_appVersion = ReadApplicationVersion\(appDir\)/);
  assert.match(host, /_runtimeBuild = ReadRuntimeBuild\(appDir\)/);
  assert.match(host, /appVersion = _appVersion/);
  assert.match(host, /runtimeProtocol = Program\.RuntimeProtocol/);
  assert.match(host, /runtimeBuild = _runtimeBuild/);
  assert.match(host, /hostProtocol = Program\.ServerHostProtocol/);
  assert.doesNotMatch(host, /internal const string AppVersion\s*=/);
  assert.doesNotMatch(host, /RuntimeAppBuild\s*=/);
});

test('GitHub Actions enforces deterministic launcher output and release-independent runtime marker naming', () => {
  assert.match(workflow, /DX_RUNTIME_BUILD: 'runtime169'/);
  assert.match(workflow, /DX_LAUNCHER_COMPONENT_VERSION: '1\.70\.1'/);
  assert.match(workflow, /DX_SERVER_HOST_COMPONENT_VERSION: '1\.70\.22'/);
  assert.doesNotMatch(workflow, /DX_RUNTIME_BUILD: '1\.70\.22-/);
  assert.match(workflow, /launcher-repeat/);
  assert.match(workflow, /Remove-Item 'windows-launcher\\bin','windows-launcher\\obj' -Recurse -Force/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256 \$launcherPrimary/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256 \$launcherRepeat/);
  assert.match(workflow, /launcher build is not deterministic/);
  assert.match(workflow, /ContinuousIntegrationBuild=true/);
});
