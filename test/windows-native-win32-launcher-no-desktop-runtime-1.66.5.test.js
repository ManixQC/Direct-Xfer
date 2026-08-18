'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const project = read('windows-launcher/DirectXfer.Launcher.csproj');
const launcher = read('windows-launcher/Program.cs');
const nativeUi = read('windows-launcher/NativeUi.cs');
const workflow = read('.github/workflows/build-windows-csharp.yml');
const installer = read('installer/Direct-Xfer.iss');

test('launcher has no WindowsDesktop or WinForms framework dependency', () => {
  assert.doesNotMatch(project, /UseWindowsForms|UseWPF|FrameworkReference[^>]+Microsoft\.WindowsDesktop\.App/);
  assert.doesNotMatch(launcher, /System\.Windows\.Forms|System\.Drawing|NotifyIcon|ContextMenuStrip|ToolStripMenuItem|FolderBrowserDialog|ApplicationContext/);
  assert.doesNotMatch(nativeUi, /System\.Windows\.Forms|System\.Drawing/);
  assert.match(nativeUi, /Shell_NotifyIconW/);
  assert.match(nativeUi, /CreatePopupMenu/);
  assert.match(nativeUi, /TrackPopupMenuEx/);
  assert.match(nativeUi, /SHBrowseForFolderW/);
  assert.match(nativeUi, /MessageBoxW/);
  assert.match(nativeUi, /SetClipboardData/);
});

test('CI downloads only Microsoft.NETCore.App runtime and rejects WindowsDesktop payloads', () => {
  assert.match(workflow, /DX_DOTNET_RUNTIME_VERSION: '10\.0\.11'/);
  assert.match(workflow, /dotnet\/Runtime\/\$env:DX_DOTNET_RUNTIME_VERSION\/dotnet-runtime-/);
  assert.doesNotMatch(workflow, /windowsdesktop-runtime-/i);
  assert.doesNotMatch(workflow, /dotnet\/WindowsDesktop\//i);
  assert.doesNotMatch(workflow, /DX_DOTNET_DESKTOP_RUNTIME_ZIP_SHA512/);
  assert.match(workflow, /Microsoft\.WindowsDesktop\.App must not be present in the portable runtime/);
});

test('installer validates core runtime only and removes retired WindowsDesktop tree after a successful upgrade', () => {
  assert.match(installer, /Microsoft\.NETCore\.App\\' \+ Version \+ '\\coreclr\.dll'/);
  assert.match(installer, /Microsoft\.NETCore\.App\\' \+ Version \+ '\\hostpolicy\.dll'/);
  assert.doesNotMatch(installer, /System\.Windows\.Forms\.dll/);
  assert.match(installer, /DelTree\(Root \+ '\\shared\\Microsoft\.WindowsDesktop\.App', True, True, True\)/);
});
