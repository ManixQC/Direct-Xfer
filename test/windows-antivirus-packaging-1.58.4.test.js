'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');
const project = fs.readFileSync(path.join(root, 'windows-launcher', 'DirectXfer.Launcher.csproj'), 'utf8');
const hostProject = fs.readFileSync(path.join(root, 'windows-server-host', 'DirectXfer.ServerHost.csproj'), 'utf8');
const expectedNodeHash = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';

test('1.62.4 launcher is a conventional C# WinForms UI with no Go launcher left', () => {
  assert.match(launcher, /const string AppVersion = "1\.62\.4"/);
  assert.match(launcher, /const string RuntimeAppBuild = "1\.62\.4-launcher45-csharp"/);
  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /System\.Windows\.Forms/);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'main.go')), false);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'go.mod')), false);
  assert.match(launcher, /NotifyIcon/);
  assert.match(launcher, /ApplicationContext/);
});

test('tray launcher contains no Node supervisor, embedded archive, downloader or kill primitive', () => {
  assert.doesNotMatch(launcher, /node\.exe|server\.js|RedirectStandardOutput|RedirectStandardError|Process\.Kill\(|taskkill\.exe|TerminateJobObject|VirtualAlloc|powershell/i);
  assert.doesNotMatch(launcher, /direct-xfer-app\.zip|go:embed|archive\/zip|nodejs\.org\/download/i);
  assert.match(launcher, /ServerHostFileName = "Direct-Xfer\.ServerHost\.exe"/);
  assert.doesNotMatch(launcher, /SignalServerHostStop|StopServerHost|FileName = hostExe|Process\.GetProcessById/);
  assert.match(launcher, /SignalServerHostReload/);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'direct-xfer-app.zip')), false);
});

test('dedicated server host owns pinned Node validation and lifecycle', () => {
  assert.match(hostProject, /<OutputType>WinExe<\/OutputType>/);
  assert.match(host, new RegExp(`NodeExeSha256 = "${expectedNodeHash}"`));
  assert.match(host, /FileSha256\(full\)/);
  assert.match(host, /DX_WINDOWS_NODE_SHA256/);
  assert.match(host, /FileName = node, Arguments = "server\.js"/);
  assert.match(host, /server\.Kill\(\)/);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'Setup-Node-Runtime.ps1')), false);
});

test('enterprise-friendly build uses a hosted Windows GitHub Actions workflow for both binaries', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /microsoft\/setup-msbuild@v3/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /actions\/upload-artifact@v6/);
  assert.match(workflow, /DirectXfer\.Launcher\.csproj/);
  assert.match(workflow, /DirectXfer\.ServerHost\.csproj/);
});

test('C# UI dispatch catches ObjectDisposedException before its InvalidOperationException base type', () => {
  const objectDisposed = launcher.indexOf('catch (ObjectDisposedException)');
  const invalidOperation = launcher.indexOf('catch (InvalidOperationException)', objectDisposed);
  assert.notEqual(objectDisposed, -1);
  assert.notEqual(invalidOperation, -1);
  assert.ok(objectDisposed < invalidOperation);
});

test('all six critical application runtime hashes moved to ServerHost and are fixed SHA-256 values', () => {
  assert.doesNotMatch(launcher, /CriticalRuntimeSha256/);
  const hashes = [...host.matchAll(/\{ "(?:package\.json|package-lock\.json|server\.js|public\/app\.js|pwa\/app\.js|node_modules\/express\/package\.json)", "([0-9a-f]{64})" \}/g)];
  assert.equal(hashes.length, 6);
});
