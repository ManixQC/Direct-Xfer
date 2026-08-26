
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('SignPath Foundation policy and OSS prerequisites are present', () => {
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
  assert.match(read('LICENSE'), /^MIT License/m);
  const policy = read('CODE_SIGNING_POLICY.md');
  assert.match(policy, /^# Code signing policy$/m);
  assert.match(policy, /Free code signing provided by \[SignPath\.io\]/);
  assert.match(policy, /certificate by \[SignPath Foundation\]/);
  assert.match(policy, /Committer and reviewer/);
  assert.match(policy, /Signing approver/);
  assert.match(read('README.md'), /^## Code signing policy$/m);
  assert.match(read('windows-launcher/README-WINDOWS-PORTABLE.md'), /^## Code signing policy$/m);
  assert.match(read('PRIVACY.md'), /does not include advertising, analytics SDKs, or usage telemetry/);
});

test('SignPath artifact configurations enforce common release ProductVersion and component FileVersion metadata', () => {
  const executables = read('signpath/artifact-configuration-executables.xml');
  const installer = read('signpath/artifact-configuration-installer.xml');
  for (const xml of [executables, installer]) {
    assert.match(xml, /xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1"/);
    assert.match(xml, /product-name="Direct-Xfer"/);
    assert.match(xml, /company-name="Direct-Xfer"/);
    assert.match(xml, /<authenticode-sign hash-algorithm="sha256"/);
  }
  assert.match(executables, /<parameter name="version" required="true"/);
  assert.match(executables, /<parameter name="launcherFileVersion" required="true"/);
  assert.match(executables, /<parameter name="serverHostFileVersion" required="true"/);
  assert.match(executables, /launcher\/Direct-Xfer\.exe[\s\S]*?product-version="\$\{version\}"[\s\S]*?file-version="\$\{launcherFileVersion\}\.0"/);
  assert.match(executables, /server-host\/Direct-Xfer\.ServerHost\.exe[\s\S]*?product-version="\$\{version\}"[\s\S]*?file-version="\$\{serverHostFileVersion\}\.0"/);
  assert.match(installer, /<parameter name="version" required="true"/);
  assert.match(installer, /product-version="\$\{version\}"/);
  assert.match(installer, /file-version="\$\{version\}\.0"/);
  assert.match(installer, /Direct-Xfer-Setup-\$\{version\}\.exe/);
});

test('Windows metadata is component-scoped for SignPath Foundation restrictions', () => {
  const launcher = read('windows-launcher/DirectXfer.Launcher.csproj');
  const host = read('windows-server-host/DirectXfer.ServerHost.csproj');
  for (const project of [launcher, host]) {
    assert.match(project, /<Product>Direct-Xfer<\/Product>/);
    assert.match(project, /<Company>Direct-Xfer<\/Company>/);
    assert.match(project, /<IncludeSourceRevisionInInformationalVersion>false<\/IncludeSourceRevisionInInformationalVersion>/);
  }
  assert.match(launcher, /<Version>1\.70\.1<\/Version>/);
  assert.match(launcher, /<FileVersion>1\.70\.1\.0<\/FileVersion>/);
  assert.match(host, /<Version>1\.70\.22<\/Version>/);
  assert.match(host, /<FileVersion>1\.70\.22\.0<\/FileVersion>/);
  const installer = read('installer/Direct-Xfer.iss');
  assert.match(installer, /VersionInfoProductName=\{#AppName\}/);
  assert.match(installer, /VersionInfoProductVersion=\{#AppVersion\}/);
  assert.match(installer, /VersionInfoCopyright=Copyright © Direct-Xfer 2026/);
  assert.match(installer, /VersionInfoOriginalFileName=Direct-Xfer-Setup-\{#AppVersion\}\.exe/);
});

test('GitHub Actions signs own executables before rebuilding and signing installer', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /sign_with_signpath:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /SIGNPATH_API_TOKEN/);
  assert.match(workflow, /SIGNPATH_EXECUTABLES_ARTIFACT_CONFIGURATION_SLUG/);
  assert.match(workflow, /SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG/);
  assert.match(workflow, /DX_LAUNCHER_COMPONENT_VERSION: '1\.70\.1'/);
  assert.match(workflow, /DX_SERVER_HOST_COMPONENT_VERSION: '1\.70\.22'/);
  assert.match(workflow, /version: "\$\{\{ env\.DX_VERSION \}\}"/);
  assert.match(workflow, /launcherFileVersion: "\$\{\{ env\.DX_LAUNCHER_COMPONENT_VERSION \}\}"/);
  assert.match(workflow, /serverHostFileVersion: "\$\{\{ env\.DX_SERVER_HOST_COMPONENT_VERSION \}\}"/);
  assert.equal((workflow.match(/-p:InformationalVersion=\$env:DX_VERSION/g) || []).length, 3);
  assert.equal((workflow.match(/signpath\/github-action-submit-signing-request@[0-9a-f]{40}/g) || []).length, 2);
  assert.match(workflow, /github-artifact-id: '\$\{\{ steps\.upload-signpath-executables\.outputs\.artifact-id \}\}'/);
  assert.match(workflow, /github-artifact-id: '\$\{\{ steps\.upload-signpath-installer\.outputs\.artifact-id \}\}'/);
  const signExecutablesAt = workflow.indexOf('Sign Direct-Xfer executables with SignPath Foundation');
  const buildInstallerAt = workflow.indexOf('- name: Build installer');
  const signInstallerAt = workflow.indexOf('Sign Direct-Xfer installer with SignPath Foundation');
  assert.ok(signExecutablesAt > 0 && buildInstallerAt > signExecutablesAt && signInstallerAt > buildInstallerAt);
  assert.match(workflow, /Verify final SignPath release signatures/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /Copy-Item 'LICENSE' \(Join-Path \$dist 'LICENSE\.txt'\)/);
});
