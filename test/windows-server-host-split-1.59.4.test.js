'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const host = read('windows-server-host', 'Program.cs');
const iss = read('installer', 'Direct-Xfer.iss');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');

test('1.62.3 launcher no longer starts or supervises the background server process', () => {
  assert.doesNotMatch(launcher, /CreateNoWindow|Process\.GetProcessById|\.Kill\(\)|FileName\s*=\s*hostExe|StartOrAttachServerHost|StopServerHost|WaitForServerHostMutexRelease|OnHostExited/);
  assert.doesNotMatch(launcher, /node\.exe|server\.js|RedirectStandardOutput|RedirectStandardError|DX_WINDOWS_NODE/);
  assert.match(launcher, /AttachToServerHost\(\)/);
  assert.match(launcher, /WaitForServerHostReady\(_lifetime\.Token\)/);
  assert.match(launcher, /ServerHostFileMatchesSession/);
  assert.match(launcher, /ServerHostReloadEventName/);
});

test('launcher uses ServerHost only through session metadata, readiness HTTP and reload IPC', () => {
  assert.match(launcher, /TryAttachReadySession\(LauncherSession session\)/);
  assert.match(launcher, /LauncherRequest\("GET", port, "\/__dx_launcher\/ready"/);
  assert.match(launcher, /EventWaitHandle\.OpenExisting\(Program\.ServerHostReloadEventName\)/);
  assert.match(launcher, /hostBuild, Program\.ServerHostBuild/);
  assert.match(launcher, /Path\.GetFullPath\(session\.hostPath\)/);
});

test('ServerHost owns Node lifecycle and supports in-process configuration reloads', () => {
  assert.match(host, /FileName = node, Arguments = "server\.js"/);
  assert.match(host, /RedirectStandardOutput = true/);
  assert.match(host, /private void StopNode\(\)/);
  assert.match(host, /server\.Kill\(\)/);
  assert.match(host, /ReloadEventName = @"Local\\DirectXferServerHostReload"/);
  assert.match(host, /WaitHandle\.WaitAny\(new WaitHandle\[\] \{ _stopEvent, _reloadEvent \}/);
  assert.match(host, /configuration reload requested/);
  assert.match(host, /ResetForReload\(\)/);
});

test('ServerHost can start before first-run launcher configuration exists', () => {
  assert.match(host, /WaitForInitialConfig\(\)/);
  assert.match(host, /while \(true\)[\s\S]*_config = LoadConfig\(\)[\s\S]*_stopEvent\.WaitOne\(250\)/);
});

test('Inno starts ServerHost independently and registers same-user logon startup', () => {
  assert.match(iss, /Name: "\{userstartup\}\\Direct-Xfer Server Host"; Filename: "\{app\}\\Direct-Xfer\.ServerHost\.exe"/);
  assert.match(iss, /\[Run\][\s\S]*Filename: "\{app\}\\Direct-Xfer\.ServerHost\.exe";[\s\S]*runasoriginaluser/);
  assert.match(iss, /AppMutex=Local\\DirectXferLauncherInstance\s*$/m);
  assert.doesNotMatch(iss, /AppMutex=.*DirectXferServerHostInstance/);
  assert.match(iss, /SignalServerHostStop/);
  assert.match(iss, /CheckForMutexes\('Local\\DirectXferServerHostInstance'\)/);
  assert.match(iss, /PrepareToInstall/);
  assert.match(iss, /CurUninstallStepChanged/);
  assert.match(iss, /Direct-Xfer\.ServerHost\.exe"; WorkingDir: "\{app\}"; Flags: nowait runasoriginaluser/);
  assert.doesNotMatch(iss, /Direct-Xfer\.ServerHost\.exe";[^\r\n]*skipifsilent/);
});

test('GitHub still builds and packages both unsigned x64 executables', () => {
  assert.match(workflow, /Build C# server host/);
  assert.match(workflow, /Build C# launcher/);
  assert.match(workflow, /Direct-Xfer\.ServerHost\.exe/);
  assert.match(workflow, /Verify Windows executables are unsigned by design/);
});
