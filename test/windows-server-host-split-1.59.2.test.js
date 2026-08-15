'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const host = read('windows-server-host', 'Program.cs');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');
const iss = read('installer', 'Direct-Xfer.iss');

test('1.59.5 separates tray UI from Node supervision', () => {
  assert.doesNotMatch(launcher, /node\.exe|server\.js|RedirectStandardOutput|RedirectStandardError|Process\.Kill\(|DX_WINDOWS_NODE|NodeExeSha256/);
  assert.match(launcher, /ServerHostFileName = "Direct-Xfer\.ServerHost\.exe"/);
  assert.match(launcher, /AttachToServerHost\(\)/);
  assert.match(launcher, /ServerHostReloadEventName/);
  assert.match(host, /AssemblyProduct\("Direct-Xfer Server Host"\)/);
  assert.match(host, /FileName = node, Arguments = "server\.js"/);
  assert.match(host, /RedirectStandardOutput = true/);
  assert.match(host, /RedirectStandardError = true/);
  assert.match(host, /private void StopNode\(\)/);
  assert.match(host, /server\.Kill\(\)/);
});

test('server host is same-user, x64 and independently single-instance', () => {
  const project = read('windows-server-host', 'DirectXfer.ServerHost.csproj');
  const manifest = read('windows-server-host', 'app.manifest');
  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/);
  assert.match(manifest, /name="DirectXfer\.WindowsServerHost"/);
  assert.match(manifest, /processorArchitecture="amd64"/);
  assert.match(manifest, /requestedExecutionLevel level="asInvoker"/);
  assert.match(host, /MutexName = @"Local\\DirectXferServerHostInstance"/);
  assert.match(host, /StopEventName = @"Local\\DirectXferServerHostStop"/);
});

test('launcher validates the dedicated host executable without starting or supervising it', () => {
  assert.match(launcher, /FileVersionInfo\.GetVersionInfo\(expected\)/);
  assert.match(launcher, /ProductName, "Direct-Xfer Server Host"/);
  assert.match(launcher, /IsAmd64Pe\(expected\)/);
  assert.match(launcher, /Path\.GetFullPath\(session\.hostPath\)/);
  assert.doesNotMatch(launcher, /FileName = hostExe|Process\.GetProcessById\(session\.hostPid\)|GetProcessStartUtcTicks\(process\)/);
});

test('server host treats a stop request during startup as a clean cancellation', () => {
  assert.match(host, /if \(_expectedStop\)[\s\S]*startup cancelled by stop request/);
  assert.match(host, /WaitHandle\.WaitAny\(new WaitHandle\[\] \{ _stopEvent, _reloadEvent \}, 100\)/);
  assert.match(host, /if \(signal == 0\) \{ _expectedStop = true; StopNode\(\); return false; \}/);
});

test('launcher never replaces the ServerHost and only waits for its independently published session', () => {
  assert.match(launcher, /WaitForServerHostReady\(_lifetime\.Token\)/);
  assert.match(launcher, /ReadSession\(\)/);
  assert.match(launcher, /TryAttachReadySession\(session\)/);
  assert.doesNotMatch(launcher, /WaitForServerHostMutexRelease|Mutex\.OpenExisting\(@"Local\\DirectXferServerHostInstance"\)|SignalServerHostStop/);
});



test('Visual Studio solution wires both x64 projects without escaped indentation artifacts', () => {
  const sln = read('windows-launcher', 'DirectXfer.Launcher.sln');
  assert.match(sln, /DirectXfer\.Launcher/);
  assert.match(sln, /DirectXfer\.ServerHost/);
  assert.match(sln, /Release\|x64/);
  assert.doesNotMatch(sln, /\\tGlobalSection|\\t\\tRelease/);
});

test('GitHub and Inno package both launcher and server host', () => {
  assert.match(workflow, /windows-server-host\/\*\*/);
  assert.match(workflow, /Build C# server host/);
  assert.match(workflow, /DirectXfer\.ServerHost\.csproj/);
  assert.match(workflow, /Direct-Xfer\.ServerHost\.exe/);
  assert.match(workflow, /Verify Windows executables are unsigned by design/);
  assert.match(iss, /AppMutex=Local\\DirectXferLauncherInstance\s*$/m);
  assert.match(iss, /CheckForMutexes\('Local\\DirectXferServerHostInstance'\)/);
  assert.match(iss, /Source: "\{#SourceDir\}\\\*"; DestDir: "\{app\}"; Flags: ignoreversion recursesubdirs createallsubdirs/);
});
