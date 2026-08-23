'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const coreUtils = require('../lib/core-utils');
const { createCoreStateApplication, initialState } = require('../lib/server/core-state-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function makeCore() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-core-state-'));
  const dataDir = path.join(temp, 'data');
  const hostRoot = path.join(temp, 'host');
  fs.mkdirSync(dataDir, { recursive:true });
  fs.mkdirSync(hostRoot, { recursive:true });
  let app;
  const bridges = {
    getServerScheme:() => 'http',
    clientIp:() => '127.0.0.1',
    scheduleSearchReindex:() => {},
    onSettingsChanged:() => {},
    resetMailerCache:() => {},
    emailSendable:() => false,
    pushSubs:() => [],
    normalizeLinkBase:(value) => String(value || '').trim(),
    cleanBrokerUrl:(value) => String(value || '').trim(),
    parseHotlinkHosts:() => [],
    normalizeShareColor:(value) => value || '',
    normalizeTags:() => [],
    normalizeDescriptionMd:(value) => String(value || ''),
    normExtList:() => [],
    addAdminCenterNotification:() => null,
    noteCenterServiceState:() => null,
    getShareService:() => null,
    getPhotoService:() => null,
    getPwaDeviceService:() => null,
    pubIp:(ip) => ip,
    getShareById:() => null,
    getTrashItems:() => [],
    getPwaDevices:() => [],
    isSessionActive:() => false,
    getActiveTransfers:() => new Map(),
  };
  app = createCoreStateApplication({
    platform:{ fs, path, crypto, os, net, tls, forge:null, nodemailer:null, webpush:null },
    config:{
      APP_NAME:'Direct-Xfer', APP_VERSION:'1.70.3', AUDIT_MAX:500,
      DATA_DIR:dataDir, DATA_KEY:'', HOST_ROOT:hostRoot,
      BIND:'127.0.0.1', PUBLIC_HOST:'', PUBLIC_URL:'', LOCAL_IP:'127.0.0.1',
      PORT:55750, TRUST_PROXY:false, UPDATE_REPO:'', UPDATE_TAG:'',
      SHUTDOWN_AFTER_DOWNLOAD:false, GOOGLE_OAUTH_BROKER_URL_ENV:'', WEBHOOK_URL:'',
      SMTP_URL:'', ADMIN_ALLOWED_IPS:[], UPDATE_CHECK:false, PUBLIC_IP_DISCOVERY:false,
      MAX_UPLOAD_BYTES:0, HISTORY_MAX:100, SECRETS_DIR:path.join(dataDir, 'secrets'),
    },
    runtimeBootstrap:{ ensureBaseDirectories() {} },
    utils:coreUtils,
    bridges,
    env:{},
  });
  return {
    app,
    close() {
      try {
        const persistence = app.initializePersistence();
        persistence.stateStore.close();
      } catch (_) {}
      fs.rmSync(temp, { recursive:true, force:true });
    },
  };
}

test('core/state application owns a two-phase live root-state cell', () => {
  const f = makeCore();
  try {
    assert.throws(() => f.app.getState(), /root state is not initialized/);
    assert.throws(() => f.app.persistNow(), /persistence is not initialized/);

    const persistence = f.app.initializePersistence();
    const first = f.app.getState();
    assert.equal(first.version, 1);
    assert.equal(first.settings.publicTheme, 'dark');
    assert.strictEqual(f.app.initializePersistence(), persistence, 'persistence initialization must be idempotent');

    const restored = { ...first, settings:{ ...first.settings, brandName:'Restored' } };
    f.app.replaceState(restored);
    assert.strictEqual(f.app.getState(), restored);
    assert.equal(f.app.settingsService.getSettings().brandName, 'Restored');
    assert.strictEqual(f.app.liveState.state, restored);
  } finally {
    f.close();
  }
});

test('initial root-state factory detaches settings and creates every durable collection', () => {
  const defaults = { publicTheme:'dark', nested:{ marker:true } };
  const state = initialState(defaults);
  assert.notStrictEqual(state.settings, defaults);
  state.settings.publicTheme = 'light';
  assert.equal(defaults.publicTheme, 'dark');
  for (const key of ['shares','trash','history','photoHistory','audit','undoLog','activityLog']) assert.ok(Array.isArray(state[key]), key);
  for (const key of ['stats','meta','ipNames']) assert.equal(Object.getPrototypeOf(state[key]), Object.prototype, key);
});

test('server delegates core/state constructors and restore bootstrap to the extracted boundary', () => {
  const server = read('server.js');
  const core = read('lib/server/core-state-application.js');
  const lifecycle = read('lib/server/state-lifecycle-application.js');
  assert.match(server, /createCoreStateApplication\(\{/);
  assert.match(server, /coreStateApplication\.initializePersistence\(\)/);
  assert.match(server, /createStateLifecycleApplication\(\{/);
  assert.match(lifecycle, /coreStateApplication\.initializeStateLifecycle\(\{/);
  for (const factory of [
    'createTlsManager','createSettingsService','createAccountService','createHostPathService',
    'createNetworkServices','createSharePresentationService','createActivityPresenceService',
    'createAuditService','createStateStore','createRestoreService','createStateBootstrapService',
  ]) {
    assert.doesNotMatch(server, new RegExp(`${factory}\\(`), `${factory} should not be composed in server.js`);
    assert.match(core, new RegExp(`${factory}\\(`), `${factory} must be composed by core-state-application.js`);
  }
  assert.ok(server.split('\n').length < 1200, `server.js should stay compact after core/state extraction (${server.split('\n').length} lines)`);
});

test('Windows runtime integrity manifest protects the new core/state composition boundary', () => {
  const source = read('lib/server/core-state-application.js');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "lib/server/core-state-application\\.js", "${hash}" \\}`));
});
