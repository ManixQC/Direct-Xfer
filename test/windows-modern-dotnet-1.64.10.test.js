'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Windows ServerHost targets modern .NET 10 with SDK-style project', () => {
  const project = read('windows-server-host/DirectXfer.ServerHost.csproj');
  assert.match(project, /<Project Sdk="Microsoft\.NET\.Sdk">/);
  assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/);
  assert.match(project, /<LangVersion>14\.0<\/LangVersion>/);
  assert.match(project, /<Nullable>enable<\/Nullable>/);
  assert.doesNotMatch(project, /TargetFrameworkVersion|\.NETFramework|System\.Web\.Extensions|LangVersion>5<\/LangVersion>/);
});

test('Windows Launcher targets modern .NET 10 without WindowsDesktop/WinForms', () => {
  const project = read('windows-launcher/DirectXfer.Launcher.csproj');
  assert.match(project, /<Project Sdk="Microsoft\.NET\.Sdk">/);
  assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/);
  assert.doesNotMatch(project, /UseWindowsForms|UseWPF|Microsoft\.WindowsDesktop\.App/);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/);
  assert.match(project, /<LangVersion>14\.0<\/LangVersion>/);
  assert.match(project, /<Nullable>enable<\/Nullable>/);
  assert.doesNotMatch(project, /TargetFrameworkVersion|\.NETFramework|System\.Web\.Extensions|LangVersion>5<\/LangVersion>/);
});

test('legacy System.Web JSON dependency is replaced with System.Text.Json compatibility adapter', () => {
  for (const dir of ['windows-launcher','windows-server-host']) {
    const program = read(`${dir}/Program.cs`);
    const compat = read(`${dir}/JsonCompat.cs`);
    assert.doesNotMatch(program, /System\.Web\.Script\.Serialization|JavaScriptSerializer/);
    assert.match(program, /private static readonly JsonCompat Json = new\(\);/);
    assert.match(compat, /using System\.Text\.Json;/);
    assert.match(compat, /IncludeFields = true/);
    assert.match(compat, /JsonConverter<object>/);
  }
});

test('launcher preserves shell opening behavior required by modern .NET', () => {
  const launcher = read('windows-launcher/Program.cs');
  assert.match(launcher, /Process\.Start\(new ProcessStartInfo \{ FileName = value, UseShellExecute = true \}\)/);
  assert.doesNotMatch(launcher, /Process\.Start\(value\)/);
});

test('Windows workflow uses pinned .NET 10 SDK and dotnet publish instead of legacy MSBuild', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /actions\/setup-dotnet@v6/);
  assert.match(workflow, /dotnet-version: '10\.0\.400'/);
  assert.match(workflow, /dotnet publish windows-server-host\\DirectXfer\.ServerHost\.csproj/);
  assert.match(workflow, /dotnet publish windows-launcher\\DirectXfer\.Launcher\.csproj/);
  assert.match(workflow, /--self-contained false/);
  assert.match(workflow, /AppHostDotNetSearch=AppRelative/);
  assert.match(workflow, /AppHostRelativeDotNet=runtime\\dotnet/);
  assert.match(workflow, /IncludeNativeLibrariesForSelfExtract=true/);
  assert.doesNotMatch(workflow, /--self-contained true/);
  assert.match(workflow, /PublishSingleFile=true/);
  assert.doesNotMatch(workflow, /setup-msbuild|\bmsbuild windows-|\.exe\.config/);
});

test('modern .NET SDK is pinned and projects do not depend on obsolete Framework App.config files', () => {
  const globalJson = JSON.parse(read('global.json'));
  assert.equal(globalJson.sdk.version, '10.0.400');
  assert.equal(globalJson.sdk.allowPrerelease, false);
  for (const rel of ['windows-launcher/DirectXfer.Launcher.csproj','windows-server-host/DirectXfer.ServerHost.csproj']) {
    const project = read(rel);
    assert.doesNotMatch(project, /App\.config|<None[^>]+App\.config|<Content[^>]+App\.config|TargetFrameworkVersion|\.NETFramework/);
  }
  const portableReadme = read('windows-launcher/README-WINDOWS-PORTABLE.md');
  assert.match(portableReadme, /framework-dependent single-file for win-x64/i);
  assert.match(portableReadme, /one private \.NET 10 runtime tree x64/i);
  assert.match(portableReadme, /No separate Microsoft \.NET Runtime or Desktop Runtime installation is required/i);
  assert.doesNotMatch(portableReadme, /winget install Microsoft\.DotNet\.DesktopRuntime|dotnet\.microsoft\.com\/en-us\/download\/dotnet/);
  const installer = read('installer/Direct-Xfer.iss');
  assert.doesNotMatch(installer, /HasNet10DesktopRuntime|DotNet10DesktopRuntimeUrl|OfferNet10DesktopRuntimeDownload|Microsoft \.NET 10 Desktop Runtime|InitializeSetup/);
  assert.doesNotMatch(installer, /HasNetFramework48OrLater|Net48Release|requires Microsoft \.NET Framework 4\.8/);
});

test('Windows C# sources progressively adopt C# 14-era syntax without behavior changes', () => {
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  const launcherJson = read('windows-launcher/JsonCompat.cs');
  const hostJson = read('windows-server-host/JsonCompat.cs');
  assert.match(launcher, /using var mutex = new Mutex/);
  assert.match(host, /using var mutex = new Mutex/);
  assert.match(launcher, /Array\.Empty<string>\(\)/);
  assert.match(launcher, /private static readonly JsonCompat Json = new\(\);/);
  assert.match(host, /private static readonly JsonCompat Json = new\(\);/);
  for (const compat of [launcherJson, hostJson]) {
    assert.match(compat, /internal T\? Deserialize<T>/);
    assert.match(compat, /using var doc = JsonDocument\.ParseValue/);
    assert.match(compat, /out var integer/);
    assert.match(compat, /value is null/);
    assert.match(compat, /Dictionary<string, object\?> dict = new\(StringComparer\.Ordinal\)/);
  }
  assert.doesNotMatch(launcher, /new string\[0\]/);
});



test('single-file Windows publish never relies on Assembly.Location for executable paths', () => {
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  for (const source of [launcher, host]) {
    assert.doesNotMatch(source, /Assembly\.GetExecutingAssembly\(\)\.Location|\.Location\s*;/);
    assert.match(source, /Environment\.ProcessPath/);
    assert.match(source, /AppContext\.BaseDirectory/);
  }
  const nativeUi = read('windows-launcher/NativeUi.cs');
  assert.match(nativeUi, /ExtractIconExW\(Program\.ExecutablePath/);
  assert.match(host, /hostPath = Program\.ExecutablePath/);
});

test('ServerHost explicitly references SystemEvents on modern .NET', () => {
  const project = read('windows-server-host/DirectXfer.ServerHost.csproj');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, /SystemEvents\.SessionEnding/);
  assert.match(project, /<PackageReference Include="Microsoft\.Win32\.SystemEvents" Version="10\.0\.10" \/>/);
});


test('modern Windows projects declare framework-dependent single-file apphosts bound to one private runtime', () => {
  for (const rel of ['windows-launcher/DirectXfer.Launcher.csproj','windows-server-host/DirectXfer.ServerHost.csproj']) {
    const project = read(rel);
    assert.match(project, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
    assert.match(project, /<SelfContained>false<\/SelfContained>/);
    assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
    assert.match(project, /<AppHostDotNetSearch>AppRelative<\/AppHostDotNetSearch>/);
    assert.match(project, /<AppHostRelativeDotNet>runtime\\dotnet<\/AppHostRelativeDotNet>/);
    assert.match(project, /<IncludeNativeLibrariesForSelfExtract>true<\/IncludeNativeLibrariesForSelfExtract>/);
  }
});

test('Windows CI probes both apphosts against the one private shared .NET runtime', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  assert.match(workflow, /Verify shared private \.NET 10 runtime/);
  assert.match(workflow, /DOTNET_ROOT_X64 = \$emptyDotnetRoot/);
  assert.match(workflow, /runtime\\dotnet/);
  assert.match(workflow, /DX_DOTNET_RUNTIME_VERSION: '10\.0\.11'/);
  assert.match(workflow, /Microsoft\.WindowsDesktop\.App must not be present/);
  assert.match(workflow, /DOTNET_MULTILEVEL_LOOKUP = '0'/);
  assert.match(workflow, /--dx-runtime-probe/);
  assert.match(workflow, /publish is not single-file/);
  assert.match(launcher, /--dx-runtime-probe/);
  assert.match(host, /--dx-runtime-probe/);
});

test('Windows installer ships a private shared .NET runtime and has no external prerequisite gate', () => {
  const installer = read('installer/Direct-Xfer.iss');
  const installerReadme = read('installer/README-INNO-SETUP.md');
  assert.doesNotMatch(installer, /HasNet10DesktopRuntime|OfferNet10DesktopRuntimeDownload|InitializeSetup/);
  assert.match(installer, /runtime\\dotnet/);
  assert.match(installerReadme, /framework-dependent single-file/i);
  assert.match(installerReadme, /one private shared \.NET 10 runtime tree/i);
  assert.match(installerReadme, /do \*\*not\*\* need to install Microsoft \.NET separately/i);
});


test('modern TLS code uses X509CertificateLoader instead of obsolete certificate constructors', () => {
  for (const rel of ['windows-launcher/Program.cs','windows-server-host/Program.cs']) {
    const source = read(rel);
    assert.match(source, /X509CertificateLoader\.LoadCertificate/);
    assert.doesNotMatch(source, /new X509Certificate2\(/);
  }
});

test('legacy WebRequest transport is replaced by HttpClient on modern .NET', () => {
  for (const rel of ['windows-launcher/Program.cs','windows-server-host/Program.cs']) {
    const source = read(rel);
    assert.match(source, /using System\.Net\.Http;/);
    assert.match(source, /new HttpClientHandler/);
    assert.match(source, /new HttpClient\(handler\)/);
    assert.match(source, /new HttpRequestMessage\(new HttpMethod\(method\), url\)/);
    assert.match(source, /UseProxy = false/);
    assert.match(source, /AllowAutoRedirect = false/);
    assert.match(source, /ServerCertificateCustomValidationCallback/);
    assert.match(source, /X-Direct-Xfer-Launcher-Token/);
    assert.doesNotMatch(source, /HttpWebRequest|HttpWebResponse|WebRequest\.Create|GetResponseStream\(\)/);
  }
});

test('HttpClient migration preserves launcher endpoint status semantics', () => {
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  assert.match(launcher, /response\.StatusCode == HttpStatusCode\.NoContent/);
  assert.match(launcher, /response\.StatusCode == HttpStatusCode\.Conflict/);
  assert.match(launcher, /response\.StatusCode != HttpStatusCode\.OK/);
  assert.match(launcher, /response\.IsSuccessStatusCode && response\.StatusCode != HttpStatusCode\.Conflict/);
  assert.match(host, /if \(response\.IsSuccessStatusCode\) break;/);
  assert.match(host, /response\.StatusCode == HttpStatusCode\.OK/);
});

test('SDK-generated assembly metadata replaces manual assembly attributes', () => {
  const launcherProject = read('windows-launcher/DirectXfer.Launcher.csproj');
  const hostProject = read('windows-server-host/DirectXfer.ServerHost.csproj');
  const launcherSource = read('windows-launcher/Program.cs');
  const hostSource = read('windows-server-host/Program.cs');
  for (const project of [launcherProject, hostProject]) {
    assert.doesNotMatch(project, /<GenerateAssemblyInfo>\s*false\s*<\/GenerateAssemblyInfo>/);
    assert.match(project, /<IncludeSourceRevisionInInformationalVersion>false<\/IncludeSourceRevisionInInformationalVersion>/);
  }
  assert.match(launcherProject, /<AssemblyVersion>1\.70\.1\.0<\/AssemblyVersion>/);
  assert.match(launcherProject, /<FileVersion>1\.70\.1\.0<\/FileVersion>/);
  assert.match(launcherProject, /<InformationalVersion>1\.70\.1<\/InformationalVersion>/);
  assert.match(hostProject, /<AssemblyVersion>1\.70\.22\.0<\/AssemblyVersion>/);
  assert.match(hostProject, /<FileVersion>1\.70\.22\.0<\/FileVersion>/);
  assert.match(hostProject, /<InformationalVersion>1\.70\.22<\/InformationalVersion>/);
  assert.doesNotMatch(launcherSource, /\[assembly:\s*Assembly(?:Title|Description|Company|Product|Copyright|Version|FileVersion|InformationalVersion)/);
  assert.doesNotMatch(hostSource, /\[assembly:\s*Assembly(?:Title|Description|Company|Product|Copyright|Version|FileVersion|InformationalVersion)/);
});


test('modern Windows C# nullability contracts match runtime-optional values', () => {
  const host = read('windows-server-host/Program.cs');
  const launcher = read('windows-launcher/Program.cs');
  assert.match(host, /Json\.Deserialize<LauncherConfig>\([\s\S]*?\?\? throw new InvalidDataException/);
  assert.match(host, /private static long GetProcessStartUtcTicks\(Process\? process\)/);
  assert.match(host, /private void AppendLog\(string\? line\)/);
  assert.match(host, /var config = _config \?\? throw new InvalidOperationException/);
  assert.match(host, /var token = _token \?\? throw new InvalidOperationException/);
  assert.doesNotMatch(host, /TryReady\(_port, _token,/);
  assert.match(host, /Json\.Deserialize<Dictionary<string, object\?>>/);
  assert.match(launcher, /private static bool GetBool\(IDictionary<string, object\?>\? payload/);
  assert.match(launcher, /private static string\? GetString\(IDictionary<string, object\?>\? payload/);
  assert.match(launcher, /var token = _token;[\s\S]*?string\.IsNullOrEmpty\(token\)/);
  assert.doesNotMatch(launcher, /LauncherRequestAnyScheme\([^;]*_token,/s);
});

test('Windows C# source eliminates the remaining nullable and unused-field warnings seen in CI', () => {
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');

  // Text resources are created through object initializers, but every field still has a safe
  // default so nullable analysis never treats a partially initialized Texts instance as invalid.
  assert.match(launcher, /internal string AppTitle = string\.Empty,[\s\S]*?Stop = string\.Empty;/);
  assert.match(launcher, /internal string FirstRunTitle = string\.Empty,[\s\S]*?PickImages = string\.Empty;/);
  assert.match(launcher, /internal string InitialPasswordLabel = string\.Empty,[\s\S]*?InitialPasswordOK = string\.Empty;/);

  // ServerHost does not consume this launcher-only preference, so it must not keep a dead field.
  assert.doesNotMatch(host, /public bool openBrowser\s*;/);

  // Shutdown is best-effort: only call the authenticated endpoint when a token is actually present.
  assert.match(host, /var token = _token;[\s\S]*?if \(!string\.IsNullOrWhiteSpace\(token\)\)[\s\S]*?LauncherRequest\("POST", _port, "\/__dx_launcher\/shutdown", token,/);
  assert.doesNotMatch(host, /LauncherRequest\("POST", _port, "\/__dx_launcher\/shutdown", _token,/);
});


test('single-file ServerHost attachment trusts authenticated runtime identity instead of brittle Win32 metadata', () => {
  const launcher = read('windows-launcher/Program.cs');
  assert.match(launcher, /StartupReadyTimeoutMs = 60000/);
  assert.match(launcher, /ServerHostFileMatchesSession[\s\S]*?string\.Equals\(session\.hostProtocol, Program\.ServerHostProtocol/);
  assert.match(launcher, /ServerHostFileMatchesSession[\s\S]*?IsAmd64Pe\(expected\)[\s\S]*?return true;/);
  assert.doesNotMatch(launcher, /FileVersionInfo\.GetVersionInfo\(expected\)/);
  assert.match(launcher, /\/__dx_launcher\/ready", token, scheme, 2000/);
});

test('ServerHost startup readiness gets a .NET 10 cold-start window and stable Local-CA SAN discovery', () => {
  const host = read('windows-server-host/Program.cs');
  const tls = read('lib/server/tls-manager.js');
  assert.match(host, /StartupReadyTimeoutMs = 60000/);
  assert.match(host, /\/__dx_launcher\/ready", token, scheme, 2000/);
  assert.match(tls, /net\.isIP\(String\(item\.address \|\| ''\)\) === 4/);
  assert.match(tls, /temporary\/privacy IPv6 addresses/);
});


test('Windows Local CA probes use .NET modern CustomRootTrust and keep readiness diagnostics', () => {
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  for (const source of [launcher, host]) {
    assert.match(source, /X509ChainTrustMode\.CustomRootTrust/);
    assert.match(source, /CustomTrustStore\.Add\(localCa\)/);
    assert.match(source, /DisableCertificateDownloads = true/);
    assert.doesNotMatch(source, /VerificationFlags = X509VerificationFlags\.AllowUnknownCertificateAuthority/);
  }
  assert.match(host, /readiness timeout detail:/);
  assert.match(host, /probe failed:/);
});


test('Launcher self-starts ServerHost and does not require Startup-folder IPC for authenticated readiness', () => {
  const launcher = read('windows-launcher/Program.cs');
  assert.match(launcher, /AttachToServerHost\(\)[\s\S]*?StartExpectedServerHost\(\);[\s\S]*?WaitForServerHostReady/);
  assert.match(launcher, /private void StartExpectedServerHost\(\)[\s\S]*?FileName = expected[\s\S]*?WorkingDirectory = PortableRoot[\s\S]*?UseShellExecute = false/);
  assert.match(launcher, /named single-instance mutex makes the duplicate process exit immediately/);
  assert.doesNotMatch(launcher, /TryAttachReadySession[\s\S]{0,900}IsServerHostIpcAlive\(\)/);
  assert.doesNotMatch(launcher, /private static bool IsServerHostIpcAlive\(/);
});

test('Launcher readiness timeout exposes the actual attach and ServerHost startup diagnostics', () => {
  const launcher = read('windows-launcher/Program.cs');
  assert.match(launcher, /private string _lastAttachFailure = string\.Empty/);
  assert.match(launcher, /Diagnostic: " \+ _lastAttachFailure/);
  assert.match(launcher, /Direct-Xfer-ServerHost-error\.log/);
  assert.match(launcher, /ServerHost error log:/);
  assert.match(launcher, /readiness failed: " \+ ex\.GetType\(\)\.Name/);
});


test('Windows runtime marker uses a conventional file and is explicitly packaged', () => {
  const host = read('windows-server-host/Program.cs');
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  const installer = read('installer/Direct-Xfer.iss');
  assert.match(host, /Path\.Combine\(root, "runtime-build\.txt"\)/);
  assert.match(host, /Path\.Combine\(root, "\.dx-runtime-build"\)/);
  assert.match(workflow, /Join-Path \$app 'runtime-build\.txt'/);
  assert.match(workflow, /\[System\.IO\.File\]::WriteAllText\(\$marker, \[string\]\$env:DX_RUNTIME_BUILD, \[System\.Text\.Encoding\]::ASCII\)/);
  assert.match(workflow, /Failed to create runtime marker/);
  assert.match(workflow, /Runtime marker disappeared during package assembly/);
  assert.doesNotMatch(workflow, /Set-Content[^\n]*runtime-build\.txt/);
  assert.match(workflow, /name: Verify portable runtime layout/);
  assert.match(workflow, /Runtime marker mismatch/);
  assert.match(installer, /Source: "\{#SourceDir\}\\runtime\\app\\runtime-build\.txt"/);
  assert.match(installer, /DestName: "runtime-build\.txt"/);
});


test('Windows rclone is an on-demand per-user component instead of installer payload', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  const bootstrap = read('lib/server/bootstrap.js');
  const installer = read('installer/Direct-Xfer.iss');
  const portable = read('windows-launcher/README-WINDOWS-PORTABLE.md');

  assert.doesNotMatch(workflow, /DX_RCLONE_VERSION|DX_RCLONE_ZIP_SHA256/);
  assert.match(workflow, /optional rclone\/Tesseract excluded/);
  assert.match(workflow, /runtime\\rclone','runtime\\tesseract/);

  assert.match(launcher, /RcloneVersion = "1\.75\.0"/);
  assert.match(launcher, /RcloneZipSha256 = "203581f0a7baeae873f2347483a798c79e2eaf5c384a4e9d866aa374f1c89ac0"/i);
  assert.match(launcher, /downloads\.rclone\.org\/v" \+ Program\.RcloneVersion/);
  assert.match(launcher, /DownloadOptionalFile\(url, zip, Program\.RcloneZipSha256/);
  assert.match(launcher, /OptionalRclonePath/);

  assert.match(host, /OptionalRclonePath/);
  assert.match(host, /RcloneUsable\(OptionalRclonePath\)/);
  assert.match(host, /EnvironmentVariables\["RCLONE_BIN"\] = OptionalRclonePath/);
  assert.match(host, /!HasNonEmptyEnvironmentVariable\(start, "RCLONE_CONFIG"\)[\s\S]*?Path\.Combine\(config\.dataDir, "rclone", "rclone\.conf"\)/);

  assert.match(bootstrap, /function resolveRcloneBinary\(\)/);
  assert.match(installer, /\{app\}\\runtime\\rclone/); // upgrade cleanup only
  assert.match(portable, /rclone is optional on Windows/i);
  assert.match(portable, /%LOCALAPPDATA%\\Direct-Xfer\\tools\\rclone\\1\.75\.0/);
});
