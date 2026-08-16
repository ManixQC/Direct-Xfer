'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'build-windows-csharp.yml');
const issPath = path.join(root, 'installer', 'Direct-Xfer.iss');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const iss = fs.readFileSync(issPath, 'utf8');

test('Inno Setup project produces the requested 1.62.4 installer name', () => {
  assert.equal(fs.existsSync(issPath), true);
  assert.match(iss, /OutputBaseFilename=Direct-Xfer-Setup-\{#AppVersion\}/);
  assert.match(iss, /#define AppVersion "1\.62\.4"/);
  assert.match(iss, /GetEnv\("DX_INNO_APP_VERSION"\)/);
  assert.match(workflow, /Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}/);
  assert.match(workflow, /Direct-Xfer-Setup-\$env:DX_VERSION\.exe/);
});

test('installer installs the complete sidecar runtime and uses a stable upgrade AppId', () => {
  assert.match(iss, /AppId=\{#AppId\}/);
  assert.match(iss, /DEBC77E6-A8DD-5E45-8389-F6158219D839/i);
  assert.match(iss, /Source: "\{#SourceDir\}\\\*"; DestDir: "\{app\}"; Flags: ignoreversion recursesubdirs createallsubdirs/);
  assert.match(iss, /DefaultDirName=\{autopf64\}\\Direct-Xfer/);
  assert.match(iss, /AppMutex=Local\\DirectXferLauncherInstance/);
});

test('installer creates standard Windows shortcuts and uninstaller metadata', () => {
  assert.match(iss, /UninstallDisplayIcon=\{app\}\\\{#AppExeName\}/);
  assert.match(iss, /Name: "\{autoprograms\}\\Direct-Xfer"/);
  assert.match(iss, /Name: "\{autodesktop\}\\Direct-Xfer"/);
  assert.match(iss, /Uninstallable=yes/);
  assert.match(iss, /CreateUninstallRegKey=yes/);
});

test('installer refuses unsupported systems before attempting to launch Direct-Xfer', () => {
  assert.match(iss, /ArchitecturesAllowed=x64compatible/);
  assert.match(iss, /MinVersion=10\.0\.17763/);
  assert.match(iss, /Net48Release = 528040/);
  assert.match(iss, /HasNetFramework48OrLater/);
});

test('GitHub workflow bundles pinned official Node.js and verifies SHA-256', () => {
  assert.match(workflow, /DX_NODE_VERSION: '24\.19\.0'/);
  assert.match(workflow, /DX_NODE_EXE_SHA256: '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'/);
  assert.match(workflow, /nodejs\.org\/download\/release\/v\$env:DX_NODE_VERSION\/win-x64\/node\.exe/);
  assert.match(workflow, /Node\.js SHA-256 mismatch/);
});

test('GitHub workflow verifies the Inno Setup compiler before running it', () => {
  assert.match(workflow, /INNO_VERSION: '6\.7\.3'/);
  assert.match(workflow, /jrsoftware\/issrc\/releases\/download\/is-6_7_3/);
  assert.match(workflow, /Get-AuthenticodeSignature -FilePath \$innoInstaller/);
  assert.match(workflow, /Pyrsys B\\\.V\\\./);
  assert.match(workflow, /ISCC\.exe/);
});

test('successful workflow uploads both installer and portable package artifacts', () => {
  assert.match(workflow, /name: Upload Windows installer/);
  assert.match(workflow, /name: Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}/);
  assert.match(workflow, /name: Upload Windows portable package/);
  assert.match(workflow, /name: Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp/);
  assert.match(workflow, /\.exe\.sha256/);
});


test('Inno 6 workflow does not use unsupported long --define compiler switches', () => {
  assert.doesNotMatch(workflow, /--define=/);
  assert.match(workflow, /DX_INNO_APP_VERSION/);
  assert.match(workflow, /DX_INNO_SOURCE_DIR/);
  assert.match(workflow, /DX_INNO_OUTPUT_DIR/);
  assert.match(workflow, /& \$env:INNO_ISCC 'installer\\Direct-Xfer\.iss'/);
  assert.match(iss, /GetEnv\("DX_INNO_SOURCE_DIR"\)/);
  assert.match(iss, /GetEnv\("DX_INNO_OUTPUT_DIR"\)/);
});
