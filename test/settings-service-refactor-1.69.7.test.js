'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsService } = require('../lib/server/settings-service');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

function ipv4ToInt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => ((result * 256) + Number(part)) >>> 0, 0);
}

function fixture(options = {}) {
  let state = { settings:{}, meta:{} };
  let persistCalls = 0;
  let persistNowCalls = 0;
  let changedCalls = 0;
  const service = createSettingsService({
    APP_NAME:'Direct-Xfer',
    shutdownAfterDownload:true,
    getState:() => state,
    persist:() => { persistCalls += 1; return true; },
    persistNow:() => { persistNowCalls += 1; return options.persistNowResult !== false; },
    onSettingsChanged:() => { changedCalls += 1; },
    getServerScheme:() => 'https',
    emailSendable:() => true,
    pushSubs:() => [{ endpoint:'one' }, { endpoint:'two' }],
    tlsManagedByEnvironment:() => false,
    configuredSelfSignedTls:() => true,
    configuredHttpsEnabled:() => true,
    localCaStatusForClient:() => ({
      available:true,
      signingAvailable:true,
      fingerprint:'AA:BB',
      expiresAt:Date.now() + (400 * 86400000),
      serverExpiresAt:1234,
      identities:{ dns:['direct-xfer.local'], ips:['192.168.1.2'] },
    }),
    tlsManager:{ ACTIVE_TLS_MODE:'local-ca', activeProvidedTlsExpiresAt:4321, tlsCertificateRestartRequired:false },
    normalizeLinkBase:(value) => String(value).startsWith('bad:') ? null : String(value).trim().replace(/\/+$/, ''),
    cleanBrokerUrl:(value) => {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('invalid');
      return parsed.href.replace(/\/$/, '');
    },
    parseHotlinkHosts:(value) => String(value || '').split(/[\s,]+/).filter(Boolean).map((item) => item.toLowerCase()),
    normalizeShareColor:(value) => /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toUpperCase() : null,
    normalizeTags:(value) => String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
    normalizeDescriptionMd:(value) => String(value || '').trim().slice(0, 2000),
    normExtList:(value) => String(value || '').split(/[\s,]+/).map((item) => item.replace(/^\./, '').toLowerCase()).filter(Boolean),
    ipToInt:ipv4ToInt,
    nodemailer:{},
    webpush:{},
    ...options.deps,
  });
  state.settings = { ...service.DEFAULT_SETTINGS };
  return {
    service,
    get state() { return state; },
    replaceState(next) { state = next; },
    get persistCalls() { return persistCalls; },
    get persistNowCalls() { return persistNowCalls; },
    get changedCalls() { return changedCalls; },
  };
}

test('the Settings domain is owned by settings-service and server.js only composes it', () => {
  const server = read('server.js');
  const source = read('lib/server/settings-service.js');
  const adminRoutes = read('lib/server/admin-settings-routes.js');
  const pwaRoutes = read('lib/server/pwa-routes.js');
  const shareService = read('lib/server/share-service.js');
  assert.match(server, /createSettingsService\(\{/);
  assert.match(server, /require\('\.\/lib\/server\/settings-service'\)/);
  assert.doesNotMatch(server, /const DEFAULT_SETTINGS\s*=\s*\{/);
  for (const name of ['getSettings', 'setSettings', 'setSettingsDurable', 'settingsForClient', 'computeSettingsPatch']) {
    assert.doesNotMatch(server, new RegExp(`function ${name}\\(`));
    assert.match(source, new RegExp(`function ${name}\\(`));
  }
  assert.match(server, /attachAdminSettingsRoutes\(applicationContext\.route\('adminSettings'/);
  const { ROUTE_DEPENDENCIES } = require('../lib/server/application-context');
  for (const name of ['computeSettingsPatch', 'setSettingsDurable', 'settingsForClient']) {
    assert.ok(ROUTE_DEPENDENCIES.adminSettings.includes(name), name);
  }
  for (const boundary of [adminRoutes, pwaRoutes, shareService]) {
    assert.doesNotMatch(boundary, /(?:live\.)?state\.settings\s*=/);
    assert.match(boundary, /setSettingsDurable\(/);
  }
  assert.match(pwaRoutes, /requires setSettingsDurable\(\)/);
  assert.match(shareService, /requires pruneHistory\(\)/);
  assert.match(shareService, /requires bumpHistoryViewRevision\(\)/);
  assert.ok(server.split('\n').length < 6100);
});

test('service construction fails closed when a required persistence or validation dependency is missing', () => {
  assert.throws(() => createSettingsService({ getState:() => ({ settings:{} }) }), /requires persist\(\)/);
});

test('defaults, ordinary writes and returned snapshots preserve the existing contract', () => {
  const f = fixture();
  assert.equal(f.service.DEFAULT_SETTINGS.shutdownAfterDownload, true);
  assert.equal(f.service.DEFAULT_SETTINGS.publicTheme, 'dark');
  assert.equal(f.service.DEFAULT_SETTINGS.backupS3Region, 'us-east-1');

  const result = f.service.setSettings({ brandName:'Acme', publicTheme:'light' });
  assert.deepEqual(result, { ...f.state.settings });
  assert.notStrictEqual(result, f.state.settings);
  result.brandName = 'mutated copy';
  assert.equal(f.state.settings.brandName, 'Acme');
  assert.equal(f.persistCalls, 1);
  assert.equal(f.changedCalls, 1);
});

test('settings snapshots and writes detach mutable allowlists from live state and caller patches', () => {
  const f = fixture();
  f.state.settings.imageHotlinkHosts = ['one.example'];
  const snapshot = f.service.getSettings();
  snapshot.imageHotlinkHosts.push('snapshot.example');
  assert.deepEqual(f.state.settings.imageHotlinkHosts, ['one.example']);

  const patchHosts = ['two.example'];
  f.service.setSettings({ imageHotlinkHosts:patchHosts });
  patchHosts.push('caller.example');
  assert.deepEqual(f.state.settings.imageHotlinkHosts, ['two.example']);
});

test('durable writes commit on success and restore the exact previous settings object on failure', () => {
  const success = fixture();
  const committed = success.service.setSettingsDurable({ accentColor:'#123456' });
  assert.equal(committed.accentColor, '#123456');
  assert.equal(success.persistNowCalls, 1);
  assert.equal(success.changedCalls, 1);

  const failure = fixture({ persistNowResult:false });
  const previous = failure.state.settings;
  assert.equal(failure.service.setSettingsDurable({ accentColor:'#abcdef' }), null);
  assert.strictEqual(failure.state.settings, previous);
  assert.equal(failure.state.settings.accentColor, '');
  assert.equal(failure.persistNowCalls, 1);
  assert.equal(failure.changedCalls, 2);
});

test('durable writes execute synchronous transaction hooks on patched state and roll back thrown commits', () => {
  const f = fixture();
  let observed = null;
  const saved = f.service.setSettingsDurable({ historyRetentionDays:7 }, {
    beforePersist:() => { observed = f.state.settings.historyRetentionDays; },
  });
  assert.equal(saved.historyRetentionDays, 7);
  assert.equal(observed, 7);

  const thrown = fixture({ deps:{
    persistNow:() => { throw new Error('disk-offline'); },
    logger:{ warn() {} },
  } });
  const previous = thrown.state.settings;
  assert.equal(thrown.service.setSettingsDurable({ brandName:'Lost' }), null);
  assert.strictEqual(thrown.state.settings, previous);

  const asyncHook = fixture({ deps:{ logger:{ warn() {} } } });
  const asyncPrevious = asyncHook.state.settings;
  assert.equal(asyncHook.service.setSettingsDurable({ brandName:'Nope' }, { beforePersist:async() => {} }), null);
  assert.strictEqual(asyncHook.state.settings, asyncPrevious);
});

test('a failed settings side effect cannot leave an unpersisted mutation active', () => {
  let attempts = 0;
  const f = fixture({ deps:{
    onSettingsChanged:() => { attempts += 1; if (attempts === 1) throw new Error('cache-reset-failed'); },
    logger:{ warn() {} },
  } });
  const previous = f.state.settings;
  assert.equal(f.service.setSettingsDurable({ brandName:'Unsafe' }), null);
  assert.strictEqual(f.state.settings, previous);
  assert.equal(attempts, 2);
});

test('all Settings methods follow the live root object after a transactional restore', () => {
  const f = fixture();
  const oldState = f.state;
  f.replaceState({ settings:{ ...f.service.DEFAULT_SETTINGS, brandName:'Restored' }, meta:{} });
  assert.equal(f.service.getSettings().brandName, 'Restored');
  f.service.setSettings({ publicLang:'fr' });
  assert.equal(f.state.settings.publicLang, 'fr');
  assert.equal(oldState.settings.publicLang, '');
});

test('client projection redacts secrets and infrastructure according to role and lite mode', () => {
  const f = fixture({ deps:{
    googleOAuthBrokerUrlEnv:'https://broker.example.test',
    webhookUrl:'https://env-hook.example.test/key',
    dataKey:'encrypted',
    smtpUrl:'smtps://env.example.test',
    adminAllowedIps:[{ network:0, prefix:0 }],
    updateCheck:false,
    publicIpDiscovery:false,
  } });
  Object.assign(f.state.settings, {
    pwChanged:true,
    webhookUrl:'https://saved-hook.example.test/key',
    smtpPass:'smtp-secret',
    backupWebdavPass:'dav-secret',
    backupS3Secret:'s3-secret',
    backupLocalDir:'/private/backups',
    publicLogo:'data:image/png;base64,AAAA',
  });
  f.state.meta.lastBackup = { at:123, ok:true };

  const owner = f.service.settingsForClient({ session:{ role:'owner' } }, false);
  assert.equal(owner.pwChanged, undefined);
  assert.equal(owner.smtpPass, undefined);
  assert.equal(owner.backupWebdavPass, undefined);
  assert.equal(owner.backupS3Secret, undefined);
  assert.equal(owner.smtpPassSet, true);
  assert.equal(owner.backupWebdavPassSet, true);
  assert.equal(owner.backupS3SecretSet, true);
  assert.equal(owner.publicLogoSet, true);
  assert.equal(owner.googleOAuthBrokerManaged, true);
  assert.equal(owner.googleOAuthBrokerUrl, 'https://broker.example.test');
  assert.equal(owner.webhookUrl, 'https://saved-hook.example.test/key');
  assert.equal(owner.webhookFromEnv, true);
  assert.equal(owner.dataEncrypted, true);
  assert.equal(owner.emailFromEnv, true);
  assert.equal(owner.emailSendable, true);
  assert.equal(owner.webPushSubs, 2);
  assert.equal(owner.tlsActive, true);
  assert.equal(owner.tlsActiveMode, 'local-ca');
  assert.deepEqual(owner.lastBackup, { at:123, ok:true });

  const operator = f.service.settingsForClient({ session:{ role:'operator' } }, true);
  for (const key of [
    'webhookUrl','adminAllowedIps','smtpHost','backupEnabled','backupLocalDir',
    'smtpPassSet','backupWebdavPassSet','backupS3SecretSet','lastBackup','allowlistFromEnv','publicLogo',
  ]) assert.equal(operator[key], undefined, key);
  assert.equal(operator.publicLogoSet, true);
  assert.equal(operator.role, 'operator');

  const auditor = f.service.settingsForClient({ session:{ role:'auditor' } }, false);
  assert.equal(auditor.webhookUrl, undefined);
  assert.equal(auditor.backupLocalDir, '/private/backups');
  assert.equal(auditor.smtpPass, undefined);

  const unknown = f.service.settingsForClient({ session:{ role:'unexpected-role' } }, false);
  assert.equal(unknown.webhookUrl, undefined);
  assert.equal(unknown.smtpHost, undefined);
  assert.equal(unknown.backupLocalDir, undefined);
  assert.equal(unknown.smtpPassSet, undefined);
});

test('settings patch validation normalizes accepted values, rejects unsafe input and ignores unknown keys', () => {
  const f = fixture();
  assert.deepEqual(f.service.computeSettingsPatch({ linkBase:'bad:value' }), { error:'invalid-domain' });
  assert.deepEqual(f.service.computeSettingsPatch({ webhookUrl:'ftp://example.test' }), { error:'invalid-webhook' });
  assert.deepEqual(f.service.computeSettingsPatch({ adminAllowedIps:'192.168.1.1/99' }), { error:'invalid-admin-ip' });
  assert.deepEqual(f.service.computeSettingsPatch({ publicLogo:'data:text/html;base64,AAAA' }), { error:'invalid-logo' });
  assert.deepEqual(f.service.computeSettingsPatch([]), { error:'invalid-settings' });
  assert.deepEqual(f.service.computeSettingsPatch('not-an-object'), { error:'invalid-settings' });

  const result = f.service.computeSettingsPatch({
    linkBase:' https://files.example.test/ ',
    imageHotlinkHosts:'IMG.EXAMPLE.test, cdn.example.test',
    idleLockMinutes:99999,
    defaultShareColor:'#abcdef',
    defaultShareTags:' Finance, Legal ',
    defaultDescriptionMd:'  confidential  ',
    defaultAllowExt:'.PDF, JPG',
    defaultBlockExt:'exe',
    adminAllowedIps:'192.168.1.10/24, 10.0.0.1',
    scheduleStart:'7:05',
    scheduleEnd:'25:00',
    expiryPresets:'1h 1h 7d nope 2w',
    publicLogo:'data:image/png;base64,AAAA',
    tlsLocalCa:true,
    unknownSetting:'discard-me',
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.patch, {
    linkBase:'https://files.example.test',
    imageHotlinkHosts:['img.example.test', 'cdn.example.test'],
    idleLockMinutes:1440,
    defaultShareColor:'#ABCDEF',
    defaultShareTags:'finance,legal',
    defaultDescriptionMd:'confidential',
    defaultAllowExt:'pdf, jpg',
    defaultBlockExt:'exe',
    tlsLocalCa:true,
    tlsSelfSigned:false,
    adminAllowedIps:'192.168.1.10/24, 10.0.0.1',
    scheduleStart:'07:05',
    scheduleEnd:'18:00',
    publicLogo:'data:image/png;base64,AAAA',
    expiryPresets:'1h,7d,2w',
  });
});

test('environment-managed OAuth and TLS settings cannot be overridden by an imported patch', () => {
  const f = fixture({ deps:{
    googleOAuthBrokerUrlEnv:'https://managed-broker.example.test',
    tlsManagedByEnvironment:() => true,
  } });
  const result = f.service.computeSettingsPatch({
    googleOAuthBrokerUrl:'https://attacker.example.test',
    tlsLocalCa:true,
    tlsSelfSigned:true,
    brandName:'Allowed',
  });
  assert.deepEqual(result, { patch:{ brandName:'Allowed' } });
});
