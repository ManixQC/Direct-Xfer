'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const project = read('windows-launcher', 'DirectXfer.Launcher.csproj');
const manifest = read('windows-launcher', 'app.manifest');
const host = read('windows-server-host', 'Program.cs');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');

test('1.62.4 launcher metadata, manifest identity and x64 target are explicit', () => {
  assert.match(launcher, /AssemblyVersion\("1\.62\.4\.0"\)/);
  assert.match(launcher, /RuntimeAppBuild = "1\.62\.4-launcher45-csharp"/);
  assert.match(project, /<ApplicationManifest>app\.manifest<\/ApplicationManifest>/);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/);
  assert.doesNotMatch(project, /<PlatformTarget>AnyCPU<\/PlatformTarget>/);
  assert.match(manifest, /name="DirectXfer\.WindowsLauncher"/);
  assert.match(manifest, /version="1\.62\.4\.0"/);
  assert.match(manifest, /processorArchitecture="amd64"/);
  assert.match(manifest, /requestedExecutionLevel level="asInvoker"/);
  assert.doesNotMatch(manifest, /MyApplication\.app/);
  assert.match(workflow, /\/p:Platform=x64/);
});

test('localhost HTTPS no longer accepts every certificate', () => {
  assert.doesNotMatch(launcher + host, /ServerCertificateValidationCallback\s*=\s*\([^\n]+=>\s*true/);
  assert.match(launcher, /ValidateLauncherServerCertificate/);
  assert.match(host, /ValidateServerCertificate/);
  assert.match(launcher, /SslPolicyErrors\.RemoteCertificateNameMismatch/);
  assert.match(launcher, /X509VerificationFlags\.AllowUnknownCertificateAuthority/);
  assert.match(launcher, /local-ca-cert\.pem/);
  assert.match(launcher, /string\.Equals\(root\.Thumbprint, localCa\.Thumbprint/);
});

test('external Node execution is explicit, x64 and SHA-256 pinned', () => {
  assert.doesNotMatch(launcher, /DX_WINDOWS_NODE|node\.exe|NodeExeSha256/);
  assert.match(host, /DX_WINDOWS_NODE_SHA256/);
  assert.match(host, /IsAmd64Pe\(full\)/);
  assert.match(host, /reader\.ReadUInt16\(\) == 0x8664/);
  assert.doesNotMatch(host, /FindOnPath\("node\.exe"\)/);
  assert.doesNotMatch(host, /SpecialFolder\.ProgramFilesX86/);
  assert.doesNotMatch(host, /Path\.Combine\(pf, "nodejs", "node\.exe"\)/);
  assert.match(host, /expected\.Length != 64/);
  assert.match(host, /FileSha256\(full\), expected/);
});

test('bundled Node remains exact-version hash pinned', () => {
  assert.match(host, /NodeVersion = "24\.19\.0"/);
  assert.match(host, /NodeExeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"/);
  assert.match(host, /return !bundled \|\| string\.Equals\(parsed\.ToString\(\), Program\.NodeVersion/);
});

test('GitHub workflow deliberately produces unsigned launcher and installer', () => {
  assert.doesNotMatch(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /azure\/login@/);
  assert.doesNotMatch(workflow, /azure\/artifact-signing-action@/);
  assert.doesNotMatch(workflow, /DX_ARTIFACT_SIGNING_ENABLED|AZURE_ARTIFACT_SIGNING_/);
  assert.match(workflow, /Verify Windows executables are unsigned by design/);
  assert.match(workflow, /must remain unsigned by design/);
  assert.match(workflow, /Direct-Xfer installer must remain unsigned by design/);
  assert.match(workflow, /Finalize installer metadata/);
});
