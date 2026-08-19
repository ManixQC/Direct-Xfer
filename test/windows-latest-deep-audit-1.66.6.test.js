'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const launcher = read('windows-launcher/Program.cs');
const nativeUi = read('windows-launcher/NativeUi.cs');
const host = read('windows-server-host/Program.cs');
const installer = read('installer/Direct-Xfer.iss');
const workflow = read('.github/workflows/build-windows-csharp.yml');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('1.67.2 version, Windows builds and PWA generation are synchronized', () => {
  assert.equal(pkg.version, '1.67.2');
  assert.equal(lock.version, '1.67.2');
  assert.equal(lock.packages[''].version, '1.67.2');
  assert.match(workflow, /^run-name: v1\.67\.2$/m);
  assert.match(workflow, /DX_RUNTIME_BUILD: '1\.67\.2-launcher89-csharp'/);
  assert.match(workflow, /DX_SERVER_HOST_BUILD: '1\.67\.2-serverhost62-csharp'/);
  assert.match(launcher, /AppVersion = "1\.67\.2"/);
  assert.match(host, /AppVersion = "1\.67\.2"/);
  for (const rel of ['pwa/theme-init.js','pwa/mobile-intelligence.js','pwa/index.html','pwa/admin-advanced.js','pwa/app.js','pwa/sw.js']) {
    assert.match(read(rel), /1\.67\.2|pwa361/);
  }
  for (const rel of ['pwa/login.html','pwa/theme-init.js','pwa/index.html','pwa/login.js','pwa/admin-advanced.js','pwa/app.js','pwa/sw.js']) {
    assert.doesNotMatch(read(rel), /v=356/);
  }
});

test('Windows bundles pinned Node while ServerHost keeps strict fallback validation', () => {
  assert.equal(pkg.engines.node, '20 || >=22');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.match(workflow, /\$nodeRuntime = Join-Path \$dist 'runtime\\node'/);
  assert.match(workflow, /Bundled Node\.js SHA-256 mismatch/);
  assert.match(installer, /function IsPinnedPrivateNode: Boolean/);
  assert.doesNotMatch(installer, /NodeDownloadPage/);
  assert.doesNotMatch(installer, /FindCompatibleSystemNode/);
  assert.match(host, /version\.Major == 22 && version >= new Version\(22, 23, 2\)/);
  assert.match(host, /version\.Major == 24 && version >= new Version\(24, 19, 0\)/);
  assert.match(host, /version\.Major == 26 && version >= new Version\(26, 7, 0\)/);
  assert.doesNotMatch(host, /parsed\.Major == 20/);
});

test('optional component menu health validates the real executable before reporting active', () => {
  const rclone = sliceBetween(launcher, 'private static bool OptionalRcloneInstalled()', 'private static bool OptionalTesseractInstalled()');
  assert.match(rclone, /RcloneBinaryMatchesPinnedVersion\(OptionalRclonePath\)/);
  const tess = sliceBetween(launcher, 'private static bool OptionalTesseractInstalled()', 'private static bool RcloneBinaryMatchesPinnedVersion');
  assert.match(tess, /TesseractBinaryMatchesPinnedVersion\(OptionalTesseractPath\)/);
  assert.match(tess, /LegacyTessdataMatchesPinnedBlobs\(\)/);
  assert.match(launcher, /RunToolCapture\(path, new\[\] \{ "version" \}, 2500\)/);
  assert.match(launcher, /RunToolCapture\(path, new\[\] \{ "--version" \}, 2500\)/);
});

test('optional component mutations are serialized across Windows sessions', () => {
  assert.match(launcher, /OptionalOperationLockPath.*\.operation\.lock/);
  assert.match(launcher, /new FileStream\(OptionalOperationLockPath, FileMode\.OpenOrCreate, FileAccess\.ReadWrite, FileShare\.None/);
  const install = sliceBetween(launcher, 'private async Task InstallOptionalToolAsync', 'private async Task RemoveOptionalToolAsync');
  const remove = sliceBetween(launcher, 'private async Task RemoveOptionalToolAsync', 'private static void CleanupStaleOptionalWorkDirectories');
  for (const block of [install, remove]) {
    assert.match(block, /TryAcquireOptionalOperationLock\(\)/);
    assert.match(block, /OptionalBusyOtherSession/);
    assert.match(block, /ReleaseOptionalOperationLock\(operationLock\)/);
  }
});

test('startup cleanup cannot delete another live session optional download work', () => {
  const cleanup = sliceBetween(launcher, 'private static void CleanupStaleOptionalWorkDirectories()', 'private static string CreateToolWorkDirectory');
  assert.match(cleanup, /TryAcquireOptionalOperationLock\(\)/);
  assert.match(cleanup, /if \(operationLock == null\) return/);
  assert.match(cleanup, /DateTime\.UtcNow - TimeSpan\.FromHours\(12\)/);
  assert.match(cleanup, /info\.LastWriteTimeUtc > cutoff/);
});

test('native password dialog restores dialog keyboard handling and resilient clipboard access', () => {
  const modal = sliceBetween(nativeUi, 'internal void ShowModal()', 'private void CreateStatic');
  assert.match(modal, /IsDialogMessageW\(_hwnd, ref message\)/);
  assert.match(nativeUi, /extern bool IsDialogMessageW\(IntPtr hDlg, ref MSG lpMsg\)/);
  const clipboard = sliceBetween(nativeUi, 'internal static bool SetClipboardText', 'internal sealed class NativeMenuBuilder');
  assert.match(clipboard, /attempt < 8/);
  assert.match(clipboard, /Thread\.Sleep\(25\)/);
});
