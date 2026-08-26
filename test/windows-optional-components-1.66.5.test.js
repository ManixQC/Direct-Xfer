'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');
const workflow = read('.github/workflows/build-windows-csharp.yml');

test('1.69.6 keeps optional helpers opt-in with explicit activation markers', () => {
  assert.match(launcher, /OptionalActivationMarkerFileName = "\.direct-xfer-enabled"/);
  assert.match(launcher, /File\.Exists\(OptionalRcloneActivationMarker\).*RcloneBinaryMatchesPinnedVersion\(OptionalRclonePath\)/s);
  assert.match(launcher, /File\.Exists\(OptionalTesseractActivationMarker\).*TesseractBinaryMatchesPinnedVersion\(OptionalTesseractPath\)/s);
  assert.match(host, /File\.Exists\(OptionalRcloneActivationMarker\) && File\.Exists\(OptionalRclonePath\)/);
  assert.match(host, /File\.Exists\(OptionalTesseractActivationMarker\) && File\.Exists\(OptionalTesseractPath\)/);
});

test('legacy 1.66.4 activation migration is explicit, integrity-aware and reloads ServerHost', () => {
  assert.match(launcher, /if \(MigrateLegacyOptionalActivationState\(\)\) SignalServerHostReload\(\)/);
  assert.match(launcher, /Downloaded only after user activation\./);
  assert.match(launcher, /migrated-from-1\.66\.4/);
  assert.match(launcher, /LegacyTessdataMatchesPinnedBlobs\(\)/);
  assert.match(launcher, /FileGitBlobSha1\(path\).*model\.GitBlobSha1/s);
  assert.match(launcher, /RcloneBinaryMatchesPinnedVersion\(OptionalRclonePath\)/);
  assert.match(launcher, /TesseractBinaryMatchesPinnedVersion\(OptionalTesseractPath\)/);
});

test('optional downloads retry transient failures and reject non-HTTPS redirects', () => {
  assert.match(launcher, /for \(var attempt = 1; attempt <= 3; attempt\+\+\)/);
  assert.match(launcher, /HttpRequestException \|\| ex is TaskCanceledException.*ex is IOException && ex is not InvalidDataException/s);
  assert.match(launcher, /MaxAutomaticRedirections = 8/);
  assert.match(launcher, /response\.RequestMessage\?\.RequestUri/);
  assert.match(launcher, /redirected outside HTTPS/);
});

test('pinned Tesseract language models are verified by exact Git blob identity', () => {
  for (const sha of [
    'bbef4675053b5b468cdb477053e28b1c698ba08e',
    'd9e2b2160be0d1ca3b8f1bf2730fae476ef3b4a6',
    '72e901f13ca52cfe34cf239a368b9ed3c0ddaf26'
  ]) assert.match(launcher, new RegExp(sha));
  assert.match(launcher, /IncrementalHash\.CreateHash\(HashAlgorithmName\.SHA1\)/);
  assert.match(launcher, /"blob " \+ info\.Length.*\\0/s);
  assert.match(launcher, /VerifyGitBlobSha1\(modelPath, model\.GitBlobSha1\)/);
});


test('repair activation stops a stale backend before replacing damaged optional files', () => {
  const start = launcher.indexOf('private async Task InstallOptionalToolAsync');
  const end = launcher.indexOf('private async Task RemoveOptionalToolAsync', start);
  const block = launcher.slice(start, end);
  assert.match(block, /replacingExistingFiles = Directory\.Exists\(existingRoot\)/);
  assert.match(block, /wasActive = DeactivateOptionalTool\(tool\)/);
  assert.match(block, /if \(wasActive \|\| replacingExistingFiles\)/);
  const reload = block.indexOf('SignalServerHostReload()');
  const stopBackend = block.indexOf('StopPreviousBackend(previousSession, 9000)');
  const install = block.lastIndexOf('InstallRcloneCore()');
  assert.ok(reload >= 0 && stopBackend > reload && install > stopBackend);
});

test('component removal deactivates before backend reload and stops the old process tree before deleting files', () => {
  const start = launcher.indexOf('private async Task RemoveOptionalToolAsync');
  const end = launcher.indexOf('private static string CreateToolWorkDirectory', start);
  const block = launcher.slice(start, end);
  const deactivate = block.indexOf('DeactivateOptionalTool(tool)');
  const reload = block.indexOf('SignalServerHostReload()');
  const stopBackend = block.indexOf('StopPreviousBackend(previousSession, 9000)');
  const stopHelpers = block.indexOf('StopOptionalToolProcesses(tool)');
  const remove = block.indexOf('RemoveRcloneCore()');
  assert.ok(deactivate >= 0 && reload > deactivate && stopBackend > reload && stopHelpers > stopBackend && remove > stopHelpers);
  assert.match(launcher, /process\.Kill\(true\).*backend did not stop before optional component replacement or removal/s);
  assert.match(host, /server\.Kill\(true\)/);
});

test('Tesseract uninstall failures are surfaced instead of silently reporting success', () => {
  const start = launcher.indexOf('private static void RemoveTesseractCore()');
  const end = launcher.indexOf('private static void DeleteParentIfEmpty', start);
  const block = launcher.slice(start, end);
  assert.match(block, /if \(process == null\) throw new InvalidOperationException/);
  assert.match(block, /throw new TimeoutException\("Tesseract removal timed out\."\)/);
  assert.match(block, /if \(process\.ExitCode != 0\)/);
  assert.match(block, /Arguments = "\/CurrentUser \/S _\?=" \+ OptionalTesseractRoot/);
  assert.doesNotMatch(block, /catch \{ \}\s*\n\s*\}\s*\n\s*if \(Directory\.Exists/);
  assert.match(launcher, /OptionalCleanupFailed/);
});


test('optional component process cleanup validates session start time and exact Node path before kill', () => {
  assert.match(launcher, /public long serverStartedUtcTicks \{ get; set; \}/);
  assert.match(launcher, /public string nodePath \{ get; set; \} = string\.Empty/);
  const start = launcher.indexOf('private static void StopPreviousBackend(LauncherSession? session');
  const end = launcher.indexOf('private static long GetProcessStartUtcTicks', start);
  const block = launcher.slice(start, end);
  assert.match(block, /started != session\.serverStartedUtcTicks/);
  assert.match(block, /process\.MainModule\?\.FileName/);
  assert.match(block, /Path\.GetFullPath\(session\.nodePath\)/);
  assert.match(block, /process\.Kill\(true\)/);
});

test('launcher session parsing is bounded and stale optional download work is cleaned on startup', () => {
  assert.match(launcher, /info\.Length <= 0 \|\| info\.Length > 64 \* 1024/);
  assert.match(launcher, /FileAttributes\.ReparsePoint/);
  assert.match(launcher, /session\.serverStartedUtcTicks <= 0/);
  assert.match(launcher, /session\.token\.Length != 48/);
  assert.match(launcher, /CleanupStaleOptionalWorkDirectories\(\);/);
  assert.match(launcher, /Directory\.EnumerateDirectories\(OptionalToolsRoot, "\.work-\*", SearchOption\.TopDirectoryOnly\)/);
  assert.match(launcher, /menu\.AddItem\(TrayStop, tr\.Stop, !_optionalToolBusy\)/);
});

test('default Windows payload still excludes rclone and Tesseract in 1.69.6', () => {
  assert.match(workflow, /DX_VERSION: '1\.71\.18'/);
  assert.doesNotMatch(workflow, /downloads\.rclone\.org|tesseract-ocr-w64-setup/);
  assert.match(workflow, /Optional Windows component leaked into the default payload/);
});
