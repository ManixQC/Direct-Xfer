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

test('Windows Launcher targets modern .NET 10 and keeps WinForms', () => {
  const project = read('windows-launcher/DirectXfer.Launcher.csproj');
  assert.match(project, /<Project Sdk="Microsoft\.NET\.Sdk">/);
  assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/);
  assert.match(project, /<UseWindowsForms>true<\/UseWindowsForms>/);
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
  assert.match(workflow, /actions\/setup-dotnet@v5/);
  assert.match(workflow, /dotnet-version: '10\.0\.400'/);
  assert.match(workflow, /dotnet publish windows-server-host\\DirectXfer\.ServerHost\.csproj/);
  assert.match(workflow, /dotnet publish windows-launcher\\DirectXfer\.Launcher\.csproj/);
  assert.match(workflow, /--self-contained false/);
  assert.match(workflow, /PublishSingleFile=true/);
  assert.doesNotMatch(workflow, /setup-msbuild|\bmsbuild windows-|\.exe\.config/);
});

test('modern .NET SDK is pinned and obsolete Framework App.config files are gone', () => {
  const globalJson = JSON.parse(read('global.json'));
  assert.equal(globalJson.sdk.version, '10.0.400');
  assert.equal(globalJson.sdk.allowPrerelease, false);
  assert.equal(fs.existsSync(path.join(ROOT, 'windows-launcher/App.config')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'windows-server-host/App.config')), false);
  assert.match(read('windows-launcher/README-WINDOWS-PORTABLE.md'), /\.NET 10 Desktop Runtime x64/);
  const installer = read('installer/Direct-Xfer.iss');
  assert.match(installer, /HasNet10DesktopRuntime/);
  assert.match(installer, /Microsoft \.NET 10 Desktop Runtime x64/);
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
  assert.match(launcher, /Icon\.ExtractAssociatedIcon\(Program\.ExecutablePath\)/);
  assert.match(host, /hostPath = Program\.ExecutablePath/);
});

test('ServerHost explicitly references SystemEvents on modern .NET', () => {
  const project = read('windows-server-host/DirectXfer.ServerHost.csproj');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, /SystemEvents\.SessionEnding/);
  assert.match(project, /<PackageReference Include="Microsoft\.Win32\.SystemEvents" Version="10\.0\.10" \/>/);
});


test('modern Windows projects declare the same single-file win-x64 deployment used by CI', () => {
  for (const rel of ['windows-launcher/DirectXfer.Launcher.csproj','windows-server-host/DirectXfer.ServerHost.csproj']) {
    const project = read(rel);
    assert.match(project, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
    assert.match(project, /<SelfContained>false<\/SelfContained>/);
    assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
  }
});

test('installer rejects prerelease .NET 10 Desktop Runtime folders as a stable runtime prerequisite', () => {
  const installer = read('installer/Direct-Xfer.iss');
  assert.match(installer, /\(Pos\('-', FindRec\.Name\) = 0\)/);
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
