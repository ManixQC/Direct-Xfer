'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launcherPath = path.join(root, 'windows-launcher', 'Program.cs');
const projectPath = path.join(root, 'windows-launcher', 'DirectXfer.Launcher.csproj');
const launcher = fs.readFileSync(launcherPath, 'utf8');
const project = fs.readFileSync(projectPath, 'utf8');
const expectedNodeHash = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';

test('1.59.0 launcher is a conventional C# WinForms project with no Go launcher left', () => {
  assert.match(launcher, /const string AppVersion = "1\.59\.0"/);
  assert.match(launcher, /const string RuntimeAppBuild = "1\.59\.0-launcher26-csharp"/);
  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /System\.Windows\.Forms/);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'main.go')), false);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'go.mod')), false);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'rsrc_windows_amd64.syso')), false);
  assert.match(launcher, /NotifyIcon/);
  assert.match(launcher, /ApplicationContext/);
});

test('C# launcher has no embedded archive, runtime downloader, packer or external kill utility', () => {
  assert.doesNotMatch(launcher, /direct-xfer-app\.zip/i);
  assert.doesNotMatch(launcher, /go:embed|archive\/zip|MkdirTemp|nodejs\.org\/download/i);
  assert.doesNotMatch(launcher, /taskkill\.exe|TerminateJobObject|AssignProcessToJobObject|VirtualAlloc|SetThreadContext|SuspendThread/i);
  assert.doesNotMatch(launcher, /powershell(?:\.exe)?|ExecutionPolicy\s+Bypass/i);
  assert.match(launcher, /LauncherRequestAnyScheme\("POST", _runtimePort, "\/__dx_launcher\/shutdown"/);
  assert.match(launcher, /server\.WaitForExit\(6000\)/);
  assert.match(launcher, /server\.Kill\(\)/);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'direct-xfer-app.zip')), false);
});

test('portable Node runtime is hash-pinned and no local executable setup script is required', () => {
  assert.match(launcher, new RegExp(`NodeExeSha256 = "${expectedNodeHash}"`));
  assert.match(launcher, /FileSha256\(path\)/);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'Setup-Node-Runtime.ps1')), false);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'build.cmd')), false);
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'build.ps1')), false);
  assert.match(launcher, /organization-approved method|méthode approuvée par votre organisation/);
});

test('enterprise-friendly build uses a hosted Windows GitHub Actions workflow', () => {
  const workflowPath = path.join(root, '.github', 'workflows', 'build-windows-csharp.yml');
  assert.equal(fs.existsSync(workflowPath), true);
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /microsoft\/setup-msbuild@v3/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /actions\/upload-artifact@v6/);
  assert.match(workflow, /DirectXfer\.Launcher\.csproj/);
});


test('C# UI dispatch catches ObjectDisposedException before its InvalidOperationException base type', () => {
  const objectDisposed = launcher.indexOf('catch (ObjectDisposedException)');
  const invalidOperation = launcher.indexOf('catch (InvalidOperationException)', objectDisposed);
  assert.notEqual(objectDisposed, -1);
  assert.notEqual(invalidOperation, -1);
  assert.ok(objectDisposed < invalidOperation);
});

test('all six critical application runtime hashes are fixed 64-hex SHA-256 values', () => {
  assert.doesNotMatch(launcher, /__[A-Z0-9_]+_SHA__/);
  const hashes = [...launcher.matchAll(/\{ "(?:package\.json|package-lock\.json|server\.js|public\/app\.js|pwa\/app\.js|node_modules\/express\/package\.json)", "([0-9a-f]{64})" \}/g)];
  assert.equal(hashes.length, 6);
});
