'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const workflow = read('.github/workflows/build-windows-csharp.yml');
const installer = read('installer/Direct-Xfer.iss');
const portable = read('windows-launcher/README-WINDOWS-PORTABLE.md');
const installerReadme = read('installer/README-INNO-SETUP.md');

test('both Windows apphosts are framework-dependent single-file and resolve only runtime\\dotnet', () => {
  for (const rel of ['windows-launcher/DirectXfer.Launcher.csproj', 'windows-server-host/DirectXfer.ServerHost.csproj']) {
    const project = read(rel);
    assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/);
    assert.match(project, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
    assert.match(project, /<SelfContained>false<\/SelfContained>/);
    assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
    assert.match(project, /<AppHostDotNetSearch>AppRelative<\/AppHostDotNetSearch>/);
    assert.match(project, /<AppHostRelativeDotNet>runtime\\dotnet<\/AppHostRelativeDotNet>/);
    assert.doesNotMatch(project, /<SelfContained>true<\/SelfContained>/);
  }
});

test('Windows CI publishes framework-dependent EXEs and assembles one pinned base runtime without WindowsDesktop', () => {
  assert.match(workflow, /--self-contained false/);
  assert.doesNotMatch(workflow, /--self-contained true/);
  assert.match(workflow, /DX_DOTNET_RUNTIME_VERSION: '10\.0\.11'/);
  assert.match(workflow, /DX_DOTNET_RUNTIME_ZIP_SHA512: 'd9ab9c0d9916b8fa3585b5f403057f594ffffb8364dac09e0007dd8ac671c86754935b980d8fb5da83cb1b82ac3cd57cc407c969e6d837aaa2fae21047cb7448'/);
  assert.doesNotMatch(workflow, /DX_DOTNET_DESKTOP_RUNTIME_ZIP_SHA512/);
  assert.match(workflow, /builds\.dotnet\.microsoft\.com\/dotnet\/Runtime\/\$env:DX_DOTNET_RUNTIME_VERSION\/dotnet-runtime-\$env:DX_DOTNET_RUNTIME_VERSION-win-x64\.zip/);
  assert.doesNotMatch(workflow, /builds\.dotnet\.microsoft\.com\/dotnet\/WindowsDesktop\//);
  assert.doesNotMatch(workflow, /windowsdesktop-runtime-/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA512 \$dotnetBaseRuntimeZip/);
  assert.match(workflow, /Expand-Archive -LiteralPath \$dotnetBaseRuntimeZip -DestinationPath \$dotnetRuntime -Force/);
  assert.match(workflow, /launcher uses native Win32 UI APIs/);
  assert.match(workflow, /\$dotnetRuntime = Join-Path \$dist 'runtime\\dotnet'/);
  assert.equal((workflow.match(/\$dotnetRuntime = Join-Path \$dist 'runtime\\dotnet'/g) || []).length, 1);
  assert.match(workflow, /Microsoft\.NETCore\.App/);
  assert.match(workflow, /Microsoft\.WindowsDesktop\.App must not be present/);
});

test('CI proves both EXEs load hostfxr from the packaged private runtime', () => {
  assert.match(workflow, /Verify shared private \.NET 10 runtime/);
  assert.match(workflow, /Do not rely only on a successful managed-code probe/);
  assert.match(workflow, /DOTNET_ROOT = \$emptyDotnetRoot/);
  assert.match(workflow, /DOTNET_ROOT_X64 = \$emptyDotnetRoot/);
  assert.match(workflow, /DOTNET_MULTILEVEL_LOOKUP = '0'/);
  assert.match(workflow, /@\('Direct-Xfer\.exe','Direct-Xfer\.ServerHost\.exe'\)/);
  assert.match(workflow, /--dx-runtime-probe/);
  assert.match(workflow, /shared private \.NET runtime probe/);
  assert.match(workflow, /DOTNET_HOST_TRACE = '1'/);
  assert.match(workflow, /DOTNET_HOST_TRACEFILE = \$traceFile/);
  assert.match(workflow, /DOTNET_HOST_TRACE_VERBOSITY = '4'/);
  assert.match(workflow, /expectedHostFxr = Join-Path \$privateDotnetRoot/);
  assert.match(workflow, /resolved fxr \[\$expectedHostFxrNormalized\]/);
  assert.match(workflow, /loaded library from \$expectedHostFxrNormalized/);
  assert.match(workflow, /did not resolve\/load hostfxr from the pinned private \.NET/);
});

test('installer updates and ships the single private runtime without pre-deleting the working copy', () => {
  assert.doesNotMatch(installer, /Type: filesandordirs; Name: "\{app\}\\runtime\\dotnet"/);
  assert.match(installer, /PrivateDotNetVersionIsComplete/);
  assert.match(installer, /AfterInstall: ValidateInstalledPrivateDotNet/);
  assert.match(installer, /BeforeInstall: ValidateAndCleanupPrivateDotNet/);
  assert.match(installer, /RaiseException\('The bundled private \.NET runtime is incomplete after installation/);
  assert.match(installer, /CleanupOldPrivateDotNetVersions/);
  assert.match(installer, /Source: "\{#SourceDir\}\\\*"; DestDir: "\{app\}"/);
  assert.doesNotMatch(installer, /HasNet10DesktopRuntime|OfferNet10DesktopRuntimeDownload|DotNet10DesktopRuntimeUrl/);
  assert.match(portable, /one private shared \.NET 10 runtime tree used by both Windows EXEs/i);
  assert.match(portable, /AppHostDotNetSearch=AppRelative/);
  assert.match(installerReadme, /one private shared \.NET 10 runtime tree/i);
  assert.match(installerReadme, /runtime\\dotnet/);
});
