'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const workflow = read('.github/workflows/build-windows-csharp.yml').replace(/\r\n?/g, '\n');
const executablesConfig = read('signpath/artifact-configuration-executables.xml');
const installerConfig = read('signpath/artifact-configuration-installer.xml');
const policy = read('CODE_SIGNING_POLICY.md');
const readme = read('README.md');
const installer = read('installer/Direct-Xfer.iss');
const releaseVersion = JSON.parse(read('package.json')).version;
const releaseRe = releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function count(source, expression) {
  return [...source.matchAll(expression)].length;
}

test(`${releaseVersion} SignPath executable configuration uses one release ProductVersion for every Direct-Xfer binary`, () => {
  assert.match(executablesConfig, /<parameter name="version" required="true"\s*\/>/);
  assert.match(executablesConfig, /<parameter name="launcherFileVersion" required="true"\s*\/>/);
  assert.match(executablesConfig, /<parameter name="serverHostFileVersion" required="true"\s*\/>/);
  assert.equal(count(executablesConfig, /product-version="\$\{version\}"/g), 2);
  assert.match(executablesConfig, /file-version="\$\{launcherFileVersion\}\.0"/);
  assert.match(executablesConfig, /file-version="\$\{serverHostFileVersion\}\.0"/);
  assert.doesNotMatch(executablesConfig, /product-version="\$\{launcherFileVersion\}"/);
  assert.doesNotMatch(executablesConfig, /product-version="\$\{serverHostFileVersion\}"/);
  assert.equal(count(executablesConfig, /<authenticode-sign\b/g), 2);
  assert.match(executablesConfig, /path="launcher\/Direct-Xfer\.exe"/);
  assert.match(executablesConfig, /path="server-host\/Direct-Xfer\.ServerHost\.exe"/);
});

test(`${releaseVersion} Windows CI builds SignPath inputs with release ProductVersion and component FileVersion checks`, () => {
  assert.match(workflow, new RegExp(`DX_VERSION: '${releaseRe}'`));
  assert.equal(count(workflow, /-p:InformationalVersion=\$env:DX_VERSION/g), 3);
  assert.match(workflow, /ProductVersion -ne \$env:DX_VERSION/);
  assert.match(workflow, /DX_LAUNCHER_COMPONENT_VERSION\.0/);
  assert.match(workflow, /DX_SERVER_HOST_COMPONENT_VERSION\.0/);
  assert.match(workflow, /version: "\$\{\{ env\.DX_VERSION \}\}"/);
  assert.match(workflow, /launcherFileVersion: "\$\{\{ env\.DX_LAUNCHER_COMPONENT_VERSION \}\}"/);
  assert.match(workflow, /serverHostFileVersion: "\$\{\{ env\.DX_SERVER_HOST_COMPONENT_VERSION \}\}"/);
});

test('SignPath requests are manual, origin-restricted, version-bound and use current GitHub artifact integration', () => {
  assert.match(workflow, /GITHUB_EVENT_NAME -ne 'workflow_dispatch'/);
  assert.match(workflow, /GITHUB_REPOSITORY -ne 'ManixQC\/Direct-Xfer'/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /refs\/tags\/v\$env:DX_VERSION/);
  assert.match(workflow, /oauth-broker\/cloudflare-worker\/package\.json/);
  assert.equal(count(workflow, /uses: actions\/upload-artifact@[0-9a-f]{40}/g), 7);
  assert.equal(count(workflow, /uses: signpath\/github-action-submit-signing-request@[0-9a-f]{40}/g), 2);
  assert.equal(count(workflow, /github-token: '\$\{\{ secrets\.GITHUB_TOKEN \}\}'/g), 2);
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /name: Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp/);
  assert.match(workflow, /name: Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}/);
});


test('unsigned Windows previews remain downloadable while canonical signed artifacts stay gated', () => {
  assert.match(workflow, /name: Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp-UNSIGNED/);
  assert.match(workflow, /name: Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}-UNSIGNED/);
  assert.match(workflow, /Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}-UNSIGNED\.exe/);
  assert.match(workflow, /Unsigned preview must not already be signed/);
  assert.match(workflow, /intentionally unsigned and may be blocked by Windows Smart App Control/);

  const unsignedUpload = workflow.indexOf('Upload unsigned portable Windows preview');
  const configValidation = workflow.indexOf('Validate SignPath Foundation configuration');
  const signRequest = workflow.indexOf('Sign Direct-Xfer executables with SignPath Foundation');
  assert.ok(unsignedUpload >= 0 && configValidation > unsignedUpload && signRequest > configValidation,
    'unsigned previews must be uploaded before SignPath validation/request can wait or fail');

  assert.match(workflow, new RegExp('uses: actions/upload-artifact@[0-9a-f]{40}[^\\n]*\\n\\s*if: \\$\\{\\{ inputs\\.sign_with_signpath \\}\\}\\n\\s*with:\\n\\s*name: Direct-Xfer-\\$\\{\\{ env\\.DX_VERSION \\}\\}-Windows-CSharp'));
  assert.match(workflow, new RegExp('uses: actions/upload-artifact@[0-9a-f]{40}[^\\n]*\\n\\s*if: \\$\\{\\{ inputs\\.sign_with_signpath \\}\\}\\n\\s*with:\\n\\s*name: Direct-Xfer-Setup-\\$\\{\\{ env\\.DX_VERSION \\}\\}'));
  assert.match(workflow, /attest-windows-provenance:[\s\S]*?if: \$\{\{ github\.repository == 'ManixQC\/Direct-Xfer' && github\.event_name == 'workflow_dispatch' && inputs\.sign_with_signpath \}\}/);
  assert.match(workflow, /Rebuild installer with SignPath-signed executables[\s\S]*?Verify installer is ready for SignPath/);
  assert.match(workflow, /Verify final SignPath release signatures[\s\S]*?Canonical release artifact names are reserved for the SignPath-validated path/);
});

test('SignPath installer configuration signs only the final Direct-Xfer setup with release metadata', () => {
  assert.match(installerConfig, /<zip-file>/);
  assert.match(installerConfig, /path="Direct-Xfer-Setup-\$\{version\}\.exe"/);
  assert.match(installerConfig, /product-version="\$\{version\}"/);
  assert.match(installerConfig, /file-version="\$\{version\}\.0"/);
  assert.equal(count(installerConfig, /<authenticode-sign\b/g), 1);
});

test('Foundation public policy, privacy display and uninstall requirements stay visible', () => {
  for (const source of [policy, readme]) {
    assert.match(source, /Code signing policy/i);
    assert.match(source, /Free code signing provided by \[SignPath\.io\]/);
    assert.match(source, /certificate by \[SignPath Foundation\]/);
  }
  assert.match(policy, /ProductVersion/);
  assert.match(policy, /FileVersion/);
  assert.match(installer, /InfoBeforeFile=\.\.\\PRIVACY\.md/);
  assert.match(installer, /Uninstallable=yes/);
  assert.match(installer, /Name: "updatecheck"/);
  assert.match(installer, /Name: "publicip"/);
  assert.match(installer, new RegExp(`#define AppVersion \"${releaseRe}\"`));
  assert.match(installer, new RegExp(`#define SourceDir \"\\.\\.\\\\dist\\\\Direct-Xfer-${releaseRe}-Windows-CSharp\"`));
});
