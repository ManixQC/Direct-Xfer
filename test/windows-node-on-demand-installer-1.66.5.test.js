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

test('former Node-on-demand architecture is retired and CI bundles pinned Node.js', () => {
  assert.match(workflow, /DX_NODE_VERSION: '24\.19\.0'/);
  assert.match(workflow, new RegExp(`DX_NODE_EXE_SHA256: '${nodeSha}'`));
  assert.match(workflow, /\$nodeRuntime = Join-Path \$dist 'runtime\\node'/);
  assert.match(workflow, /\$nodeUrl = "https:\/\/nodejs\.org\/download\/release\/v\$env:DX_NODE_VERSION\/win-x64\/node\.exe"/);
  assert.match(workflow, /Invoke-DxDownload \$nodeUrl \$nodeExe/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256 \$nodeExe/);
  assert.match(workflow, /& \$nodeExe --version/);
  assert.match(workflow, /@\('runtime\\rclone','runtime\\tesseract'\)/);
  assert.doesNotMatch(workflow, /@\('runtime\\node','runtime\\rclone','runtime\\tesseract'\)/);
});

test('Inno Setup performs no Node network download and validates bundled private Node', () => {
  assert.doesNotMatch(installer, /NodeDownloadUrl/);
  assert.doesNotMatch(installer, /NodeDownloadPage/);
  assert.doesNotMatch(installer, /ShouldCopyDownloadedNode/);
  assert.doesNotMatch(installer, /FindCompatibleSystemNode/);
  assert.doesNotMatch(installer, /PrepareNodeRuntime/);
  assert.match(installer, /Node\.js is bundled in SourceDir\\runtime\\node\\node\.exe by GitHub Actions/);
  assert.match(installer, new RegExp(nodeSha));
  assert.match(installer, /GetBinaryType\(PrivateNodePath, BinaryType\)/);
  assert.match(installer, /BinaryType <> Scs64BitBinary/);
  assert.match(installer, /CompareText\(Version, '\{#NodeVersion\}'\) <> 0/);
  assert.match(installer, /CompareText\(Sha256, '\{#NodeExeSha256\}'\) <> 0/);
  assert.match(installer, /ExecAsOriginalUser\(FileName, '--version'/);
  assert.match(installer, /Type: files; Name: "\{app\}\\runtime\\node\\external-node\.ini"/);
});

test('portable layout verification requires exact bundled Node and keeps rclone/Tesseract optional', () => {
  assert.match(workflow, /Missing bundled Node\.js runtime/);
  assert.match(workflow, /Bundled Node\.js payload SHA-256 mismatch/);
  assert.match(workflow, /Bundled Node\.js payload version mismatch/);
  assert.match(workflow, /Obsolete external Node\.js receipt leaked into the portable payload/);
  assert.match(workflow, /@\('runtime\\rclone','runtime\\tesseract'\)/);
});

test('ServerHost keeps pinned private Node validation and reinstall guidance', () => {
  assert.match(host, /PortableNodePath/);
  assert.match(host, /Program\.NodeExeSha256/);
  assert.match(host, /string\.Equals\(FileSha256\(full\), expectedHash/);
  assert.match(host, /Re-run the Direct-Xfer installer to restore the bundled Node\.js runtime/);
});

test('portable documentation states Node is bundled and Setup does not download it', () => {
  assert.match(portable, /Node\.js 24\.19\.0 x64 is bundled/i);
  assert.match(portable, /installer itself performs no Node\.js download/i);
  assert.match(portable, /rclone and Tesseract remain.*excluded/i);
});
