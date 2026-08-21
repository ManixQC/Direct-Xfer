'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('1.69.3 installer makes startup and outbound privacy choices explicit', () => {
  const iss = read('installer/Direct-Xfer.iss');
  assert.match(iss, /InfoBeforeFile=\.\.\\PRIVACY\.md/);
  assert.match(iss, /Name: "autostart"; Description: "Start Direct-Xfer automatically with Windows"/);
  assert.match(iss, /Name: "updatecheck"; Description: "Allow automatic update checks \(contacts Docker Hub\)"/);
  assert.match(iss, /Name: "publicip"; Description: "Allow public IP discovery at startup \(contacts public IP services\)"/);
  assert.match(iss, /\{userstartup\}\\Direct-Xfer Server Host[^\n]+Tasks: autostart/);
  assert.match(iss, /install-update-check-disable\.flag/);
  assert.match(iss, /install-public-ip-disable\.flag/);
  assert.match(iss, /AppPublisherURL=https:\/\/github\.com\/ManixQC\/Direct-Xfer/);
  assert.match(iss, /AppSupportURL=https:\/\/github\.com\/ManixQC\/Direct-Xfer\/issues/);
  assert.match(iss, /AppUpdatesURL=https:\/\/github\.com\/ManixQC\/Direct-Xfer\/releases/);
});

test('1.69.3 one-shot Windows install choices are persisted then remain editable', () => {
  const host = read('windows-server-host/Program.cs');
  const server = read('server.js');
  const prefs = read('lib/server/windows-install-preferences.js');
  assert.match(host, /DX_WINDOWS_INSTALL_UPDATE_CHECK/);
  assert.match(host, /DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY/);
  assert.match(server, /applyWindowsInstallPreferences\(state, process\.env\)/);
  assert.match(prefs, /state\.settings\[setting\] = desired/);
  assert.match(prefs, /publicIpDiscovery/);
  assert.match(prefs, /fs\.unlinkSync\(marker\)/);
});

test('1.69.3 public-IP discovery can be disabled before any public-IP fetch', async () => {
  const { createNetworkServices } = require('../lib/server/network-services');
  const oldFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('unexpected network'); };
  try {
    const state = { meta:{}, settings:{ publicIpDiscovery:false } };
    const services = createNetworkServices({
      net: require('node:net'), os: require('node:os'), LOCAL_IP:'', APP_VERSION:'1.69.3', UPDATE_REPO:'owner/repo', UPDATE_TAG:'latest',
      compareSemver:()=>0, updateCheckEnabled:()=>false, publicIpDiscoveryEnabled:()=>false, addAdminCenterNotification:()=>{},
      getState:()=>state, persist:()=>{}, maskToPrefix:()=>24, ipToInt:()=>null, intToIp:()=>'', isPrivateIp:()=>false,
      getSettings:()=>state.settings, flagFromCode:()=>'', noteCenterServiceState:()=>{},
    });
    assert.equal(await services.getPublicIP(), null);
    assert.equal(services.getPublicIPCached(), null);
    assert.equal(fetches, 0);
  } finally { global.fetch = oldFetch; }
});

test('1.69.3 release template and repository policy meet SignPath page requirements', () => {
  const readme = read('README.md');
  const release = read('signpath/RELEASE_NOTES_TEMPLATE.md');
  const privacy = read('PRIVACY.md');
  assert.match(readme, /^## Code signing policy$/m);
  assert.match(release, /^## Code signing policy$/m);
  assert.match(release, /Free code signing provided by \[SignPath\.io\]/);
  assert.match(release, /certificate by \[SignPath Foundation\]/);
  assert.match(privacy, /Allow automatic update checks/);
  assert.match(privacy, /Allow public IP discovery at startup/);
});
