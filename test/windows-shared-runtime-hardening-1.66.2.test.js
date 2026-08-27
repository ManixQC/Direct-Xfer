'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const workflow = read('.github/workflows/build-windows-csharp.yml');
const installer = read('installer/Direct-Xfer.iss');
const installerReadme = read('installer/README-INNO-SETUP.md');

test('private .NET CI probe cannot silently pass against setup-dotnet runtime', () => {
  assert.match(workflow, /DOTNET_ROOT = \$emptyDotnetRoot/);
  assert.match(workflow, /DOTNET_ROOT_X64 = \$emptyDotnetRoot/);
  assert.match(workflow, /DOTNET_MULTILEVEL_LOOKUP = '0'/);
  assert.match(workflow, /DOTNET_HOST_TRACE = '1'/);
  assert.match(workflow, /DOTNET_HOST_TRACE_VERBOSITY = '4'/);
  assert.match(workflow, /DOTNET_HOST_TRACEFILE = \$traceFile/);
  assert.match(workflow, /Get-Content -LiteralPath \$traceFile -Raw/);
  assert.match(workflow, /\$privateRootNormalized/);
  assert.match(workflow, /\$expectedHostFxrNormalized/);
  assert.match(workflow, /expectedHostFxr = Join-Path \$privateDotnetRoot/);
  assert.match(workflow, /resolved fxr \[\$expectedHostFxrNormalized\]/);
  assert.match(workflow, /loaded library from \$expectedHostFxrNormalized/);
  assert.match(workflow, /\$env:DOTNET_HOST_TRACE = \$previousHostTrace/);
  assert.match(workflow, /\$env:DOTNET_HOST_TRACEFILE = \$previousHostTraceFile/);
  assert.match(workflow, /\$env:DOTNET_HOST_TRACE_VERBOSITY = \$previousHostTraceVerbosity/);
});

test('installer preserves the current private .NET tree until replacement succeeds', () => {
  assert.doesNotMatch(installer, /Type:\s*filesandordirs;\s*Name:\s*"\{app\}\\runtime\\dotnet"/i);
  assert.match(installer, /#define EnvDotNetRuntimeVersion GetEnv\("DX_INNO_DOTNET_RUNTIME_VERSION"\)/);
  assert.match(installer, /#define DotNetRuntimeVersion "10\.0\.11"/);
  assert.match(workflow, /DX_INNO_DOTNET_RUNTIME_VERSION\s*=\s*\$env:DX_DOTNET_RUNTIME_VERSION/);
  assert.match(installer, /function PrivateDotNetVersionIsComplete: Boolean;/);
  assert.match(installer, /Root \+ '\\dotnet\.exe'/);
  assert.match(installer, /host\\fxr\\' \+ Version \+ '\\hostfxr\.dll'/);
  assert.match(installer, /Microsoft\.NETCore\.App\\' \+ Version \+ '\\coreclr\.dll'/);
  assert.match(installer, /Microsoft\.NETCore\.App\\' \+ Version \+ '\\hostpolicy\.dll'/);
  assert.doesNotMatch(installer, /System\.Windows\.Forms\.dll/);
  assert.match(installer, /Removed retired Microsoft\.WindowsDesktop\.App runtime tree/);
  assert.match(installer, /AfterInstall: ValidateInstalledPrivateDotNet/);
  assert.match(installer, /procedure ValidateInstalledPrivateDotNet;/);
  assert.match(installer, /if not PrivateDotNetVersionIsComplete then/);
  assert.match(installer, /RaiseException\(CustomMessage\('DotNetRuntimeInvalid'\)\)/);
  assert.match(installer, /^en\.DotNetRuntimeInvalid=The bundled private \.NET runtime is incomplete after installation/m);
  assert.match(installer, /BeforeInstall: ValidateAndCleanupPrivateDotNet/);
  assert.match(installer, /procedure ValidateAndCleanupPrivateDotNet;/);
  assert.match(installer, /ValidateInstalledPrivateDotNet;/);
  assert.match(installer, /CleanupOldPrivateDotNetVersions;/);
  assert.doesNotMatch(installer, /CurStepChanged\(CurStep: TSetupStep\)/);
});

test('pre-run cleanup keeps the pinned runtime and removes stale patch directories only', () => {
  assert.match(installer, /procedure CleanupOldDotNetVersionsIn\(const BaseDir, KeepVersion: String\);/);
  assert.match(installer, /FindFirst\(AddBackslash\(BaseDir\) \+ '\*', FindRec\)/);
  assert.match(installer, /CompareText\(FindRec\.Name, KeepVersion\) <> 0/);
  assert.match(installer, /DelTree\(EntryPath, True, True, True\)/);
  assert.match(installer, /FindNext\(FindRec\)/);
  assert.match(installer, /FindClose\(FindRec\)/);
  assert.match(installer, /Skipping private \.NET cleanup because the newly installed runtime is incomplete/);
  assert.match(installerReadme, /DX_INNO_DOTNET_RUNTIME_VERSION/);
  assert.match(installerReadme, /Private \.NET upgrades are deliberately non-destructive/i);
  assert.match(installerReadme, /runtime\\dotnet/i);
  assert.match(installerReadme, /runtime-build\.txt.*installed last/i);
  assert.match(installerReadme, /before any `\[Run\]` entry/i);
  assert.match(installerReadme, /BeforeInstall/i);
});
