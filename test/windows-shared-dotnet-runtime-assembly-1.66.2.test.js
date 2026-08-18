'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-windows-csharp.yml'), 'utf8');

// Regression for CI failure: WindowsDesktop runtime ZIP alone does not materialize
// runtime\\dotnet\\dotnet.exe. Direct-Xfer must merge the base runtime ZIP first.
test('private .NET runtime tree merges base runtime before WindowsDesktop framework', () => {
  const baseDownload = workflow.indexOf('$dotnetBaseRuntimeUrl');
  const baseExpand = workflow.indexOf('Expand-Archive -LiteralPath $dotnetBaseRuntimeZip -DestinationPath $dotnetRuntime -Force');
  const desktopDownload = workflow.indexOf('$dotnetDesktopRuntimeUrl');
  const desktopExpand = workflow.indexOf('Expand-Archive -LiteralPath $dotnetDesktopRuntimeZip -DestinationPath $dotnetRuntime -Force');
  const dotnetProbe = workflow.indexOf("$privateDotnetExe = Join-Path $dotnetRuntime 'dotnet.exe'");
  assert.ok(baseDownload >= 0, 'base runtime download is missing');
  assert.ok(baseExpand > baseDownload, 'base runtime must be expanded after download');
  assert.ok(desktopDownload > baseExpand, 'WindowsDesktop archive must be layered after the base runtime');
  assert.ok(desktopExpand > desktopDownload, 'WindowsDesktop archive must be expanded');
  assert.ok(dotnetProbe > desktopExpand, 'dotnet.exe must be checked only after both archives are merged');
});

test('both Microsoft runtime archives are pinned by official SHA-512 values', () => {
  assert.match(workflow, /DX_DOTNET_RUNTIME_ZIP_SHA512: 'd9ab9c0d9916b8fa3585b5f403057f594ffffb8364dac09e0007dd8ac671c86754935b980d8fb5da83cb1b82ac3cd57cc407c969e6d837aaa2fae21047cb7448'/);
  assert.match(workflow, /DX_DOTNET_DESKTOP_RUNTIME_ZIP_SHA512: '1d32a9bf6c93f50dee5734048f825998b98266d0e28846dbee0310e2aad7e28fc2251e38ffad6a474a1e57381895130f2b3e1e1a4f875ac7f79271d91c6eb433'/);
  assert.match(workflow, /Private \.NET Runtime SHA-512 mismatch/);
  assert.match(workflow, /Private \.NET WindowsDesktop Runtime SHA-512 mismatch/);
});
