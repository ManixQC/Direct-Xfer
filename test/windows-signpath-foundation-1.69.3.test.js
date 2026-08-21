
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

test('SignPath artifact configurations enforce Direct-Xfer PE metadata', () => {
  const executables = read('signpath/artifact-configuration-executables.xml');
  const installer = read('signpath/artifact-configuration-installer.xml');
  for (const xml of [executables, installer]) {
    assert.match(xml, /xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1"/);
    assert.match(xml, /<parameter name="version" required="true"/);
    assert.match(xml, /product-name="Direct-Xfer"/);
    assert.match(xml, /product-version="\$\{version\}"/);
    assert.match(xml, /file-version="\$\{version\}\.0"/);
    assert.match(xml, /company-name="Direct-Xfer"/);
    assert.match(xml, /<authenticode-sign hash-algorithm="sha256"/);
  }
  assert.match(executables, /launcher\/Direct-Xfer\.exe/);
  assert.match(executables, /server-host\/Direct-Xfer\.ServerHost\.exe/);
  assert.match(installer, /Direct-Xfer-Setup-\$\{version\}\.exe/);
});

test('Windows metadata is uniform for SignPath Foundation restrictions', () => {
  const launcher = read('windows-launcher/DirectXfer.Launcher.csproj');
  const host = read('windows-server-host/DirectXfer.ServerHost.csproj');
  for (const project of [launcher, host]) {
    assert.match(project, /<Product>Direct-Xfer<\/Product>/);
    assert.match(project, /<Company>Direct-Xfer<\/Company>/);
    assert.match(project, /<Version>1\.69\.3<\/Version>/);
    assert.match(project, /<FileVersion>1\.69\.3\.0<\/FileVersion>/);
    assert.match(project, /<InformationalVersion>1\.69\.3<\/InformationalVersion>/);
    assert.match(project, /<IncludeSourceRevisionInInformationalVersion>false<\/IncludeSourceRevisionInInformationalVersion>/);
  }
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
  assert.equal((workflow.match(/signpath\/github-action-submit-signing-request@v2/g) || []).length, 2);
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
