'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const host = read('windows-server-host', 'Program.cs');
const launcherProject = read('windows-launcher', 'DirectXfer.Launcher.csproj');
const launcherManifest = read('windows-launcher', 'app.manifest');
const hostProject = read('windows-server-host', 'DirectXfer.ServerHost.csproj');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');

test('1.62.3 launcher identity remains explicit and x64', () => {
  assert.match(launcher, /AssemblyVersion\("1\.62\.3\.0"\)/);
  assert.match(launcher, /RuntimeAppBuild = "1\.62\.3-launcher44-csharp"/);
  assert.match(launcherProject, /<PlatformTarget>x64<\/PlatformTarget>/);
  assert.match(launcherManifest, /name="DirectXfer\.WindowsLauncher"/);
  assert.match(launcherManifest, /version="1\.62\.3\.0"/);
  assert.match(launcherManifest, /processorArchitecture="amd64"/);
  assert.match(hostProject, /<PlatformTarget>x64<\/PlatformTarget>/);
});

test('localhost HTTPS validation remains strict in both Windows components', () => {
  for (const source of [launcher, host]) {
    assert.doesNotMatch(source, /ServerCertificateValidationCallback\s*=\s*\([^\n]+=>\s*true/);
    assert.match(source, /RemoteCertificateNameMismatch/);
    assert.match(source, /AllowUnknownCertificateAuthority/);
    assert.match(source, /local-ca-cert\.pem/);
    assert.match(source, /root\.Thumbprint, localCa\.Thumbprint/);
  }
});

test('Node trust and process supervision exist only in ServerHost', () => {
  assert.doesNotMatch(launcher, /DX_WINDOWS_NODE_SHA256|NodeExeSha256|FileName = node|server\.Kill\(\)/);
  assert.match(host, /DX_WINDOWS_NODE_SHA256/);
  assert.match(host, /NodeExeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"/);
  assert.match(host, /IsAmd64Pe\(full\)/);
  assert.match(host, /expected\.Length != 64/);
  assert.match(host, /process\.WaitForExit\(3000\)/);
});

test('workflow deliberately leaves both Direct-Xfer executables unsigned', () => {
  assert.doesNotMatch(workflow, /azure\/artifact-signing-action@|azure\/login@|id-token: write/);
  assert.match(workflow, /Verify Windows executables are unsigned by design/);
  assert.match(workflow, /Direct-Xfer\.ServerHost\.exe/);
  assert.match(workflow, /Direct-Xfer installer must remain unsigned by design/);
});
