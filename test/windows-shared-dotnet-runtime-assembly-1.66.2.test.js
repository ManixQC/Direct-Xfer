'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-windows-csharp.yml'), 'utf8');

// The launcher moved from WinForms to native Win32. The private runtime must now be
// built from the base Microsoft.NETCore.App archive only.
test('private .NET runtime tree uses only the base runtime archive', () => {
  const baseDownload = workflow.indexOf('$dotnetBaseRuntimeUrl');
  const baseExpand = workflow.indexOf('Expand-Archive -LiteralPath $dotnetBaseRuntimeZip -DestinationPath $dotnetRuntime -Force');
  const dotnetProbe = workflow.indexOf("$privateDotnetExe = Join-Path $dotnetRuntime 'dotnet.exe'");
  assert.ok(baseDownload >= 0, 'base runtime download is missing');
  assert.ok(baseExpand > baseDownload, 'base runtime must be expanded after download');
  assert.ok(dotnetProbe > baseExpand, 'dotnet.exe must be checked after base runtime extraction');
  assert.doesNotMatch(workflow, /windowsdesktop-runtime-/);
  assert.doesNotMatch(workflow, /dotnet\/WindowsDesktop\//);
  assert.doesNotMatch(workflow, /\$dotnetDesktopRuntimeZip|\$dotnetDesktopRuntimeUrl|\$dotnetDesktopRuntimeHash/);
});

test('base Microsoft runtime archive is pinned and WindowsDesktop is rejected', () => {
  assert.match(workflow, /DX_DOTNET_RUNTIME_ZIP_SHA512: 'd9ab9c0d9916b8fa3585b5f403057f594ffffb8364dac09e0007dd8ac671c86754935b980d8fb5da83cb1b82ac3cd57cc407c969e6d837aaa2fae21047cb7448'/);
  assert.doesNotMatch(workflow, /DX_DOTNET_DESKTOP_RUNTIME_ZIP_SHA512/);
  assert.match(workflow, /Private \.NET Runtime SHA-512 mismatch/);
  assert.match(workflow, /Microsoft\.WindowsDesktop\.App must not be present/);
});
