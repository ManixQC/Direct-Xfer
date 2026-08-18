'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const workflow = read('.github/workflows/build-windows-csharp.yml');
const installer = read('installer/Direct-Xfer.iss');
const host = read('windows-server-host/Program.cs');
const portable = read('windows-launcher/README-WINDOWS-PORTABLE.md');

const nodeSha = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';

test('Windows CI no longer puts Node.js in the base payload', () => {
  assert.match(workflow, /DX_NODE_VERSION: '24\.19\.0'/);
  assert.match(workflow, new RegExp(`DX_NODE_EXE_SHA256: '${nodeSha}'`));
  assert.doesNotMatch(workflow, /\$node\s*=\s*Join-Path \$dist 'runtime\\node'/);
  assert.doesNotMatch(workflow, /Invoke-DxDownload \$nodeUrl \$nodeExe/);
  assert.match(workflow, /@\('runtime\\node','runtime\\rclone','runtime\\tesseract'\)/);
  assert.match(workflow, /DX_INNO_NODE_VERSION = \$env:DX_NODE_VERSION/);
  assert.match(workflow, /DX_INNO_NODE_EXE_SHA256 = \$env:DX_NODE_EXE_SHA256/);
});

test('Inno Setup preserves an existing private Node and downloads only when missing', () => {
  assert.doesNotMatch(installer, /Type: filesandordirs; Name: "\{app\}\\runtime\\node"/);
  assert.match(installer, /NodeDownloadUrl "https:\/\/nodejs\.org\/download\/release\/v" \+ NodeVersion \+ "\/win-x64\/node\.exe"/);
  assert.match(installer, new RegExp(nodeSha));
  assert.match(installer, /Source: "\{tmp\}\\\{#NodeTempBaseName\}"; DestDir: "\{app\}\\runtime\\node"; DestName: "node\.exe"; Flags: external ignoreversion; Check: ShouldCopyDownloadedNode/);

  const prepareStart = installer.indexOf('function PrepareNodeRuntime: String;');
  const prepareEnd = installer.indexOf('function ShouldCopyDownloadedNode', prepareStart);
  const prepare = installer.slice(prepareStart, prepareEnd);
  assert.match(prepare, /if IsPinnedPrivateNode then/);
  assert.match(prepare, /TryExistingNodeReceipt/);
  assert.match(prepare, /FindCompatibleSystemNode/);
  assert.match(prepare, /NodeNeedsDownload := True/);
  assert.match(prepare, /NodeDownloadPage\.Add\('\{#NodeDownloadUrl\}', '\{#NodeTempBaseName\}', '\{#NodeExeSha256\}'\)/);

  const installStart = installer.indexOf('function PrepareToInstall');
  const installBlock = installer.slice(installStart, installer.indexOf('procedure CurUninstallStepChanged', installStart));
  assert.match(installBlock, /StopServerHostAndWait/);
  assert.match(installBlock, /Result := PrepareNodeRuntime/);
});

test('system Node reuse is x64/version/hash checked and persisted as an integrity receipt', () => {
  assert.match(installer, /GetBinaryTypeW@kernel32\.dll/);
  assert.match(installer, /BinaryType <> Scs64BitBinary/);
  assert.match(installer, /IsSupportedNodeVersion\(Major, Minor, Revision\)/);
  assert.match(installer, /Major = 22.*Minor = 23.*Revision >= 2/s);
  assert.match(installer, /Major = 24.*Minor = 19/s);
  assert.match(installer, /Major = 26.*Minor = 7/s);
  assert.match(installer, /GetSHA256OfFile\(FileName\)/);
  assert.match(installer, /function FindCompatibleNodeOnPath/);
  assert.match(installer, /RegQueryStringValue\(HKCU, 'SOFTWARE\\Node\.js'/);
  assert.match(installer, /RegQueryStringValue\(HKLM, 'SOFTWARE\\Node\.js'/);
  assert.match(installer, /external-node\.ini/);
  assert.match(installer, /ReceiptSize > 16 \* 1024/);
  assert.match(installer, /ReceiptAttrs and FileAttributeReparsePoint/);
  assert.match(installer, /CompareText\(Candidate, PrivateNodePath\) = 0/);
  assert.match(installer, /SetIniString\('node', 'path', DetectedNodePath/);
  assert.match(installer, /SetIniString\('node', 'version', DetectedNodeVersion/);
  assert.match(installer, /SetIniString\('node', 'sha256', Lowercase\(DetectedNodeSha256\)/);
});

test('ServerHost trusts only pinned private Node or the exact installer receipt', () => {
  assert.match(host, /ExternalNodeReceiptPath.*external-node\.ini/);
  assert.match(host, /TryReadExternalNodeReceipt/);
  assert.match(host, /info\.Length <= 0 \|\| info\.Length > 16 \* 1024/);
  assert.match(host, /FileAttributes\.ReparsePoint/);
  assert.match(host, /GetPrivateProfileString/);
  assert.match(host, /TryReadNodeReceiptValue\("sha256", out sha256\)/);
  assert.match(host, /string\.Equals\(FileSha256\(full\), expectedHash/);
  assert.match(host, /string\.Equals\(parsed\.ToString\(\), expectedVersion/);
  assert.match(host, /Re-run the Direct-Xfer installer so it can download Node\.js when needed/);
});

test('portable documentation states that Node is outside the base payload', () => {
  assert.match(portable, /no `runtime\/node` directory/i);
  assert.match(portable, /fetched only when Setup actually needs it/i);
});
