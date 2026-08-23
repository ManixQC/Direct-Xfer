'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShareService } = require('../lib/server/share-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-share-domain-'));
  const inbox = path.join(root, 'inbox');
  const pending = path.join(root, 'pending');
  const enc = path.join(root, 'enc');
  fs.mkdirSync(inbox, { recursive:true });
  fs.mkdirSync(pending, { recursive:true });
  fs.mkdirSync(enc, { recursive:true });
  let state = {
    shares: [], trash: [], stats: {}, meta: {}, undoLog: [], history: [], ipNames: {},
    settings: { tokenBytes:12, autoArchiveExpiredDays:0, expiredDataRetentionDays:0 },
  };
  let flushes = 0;
  const account = { id:'a1', username:'owner', role:'owner' };
  const base = {
    HOST_ROOT: root,
    INBOX_DIR: inbox,
    PENDING_DIR: pending,
    ENC_DIR: enc,
    getState: () => state,
    getSettings: () => ({ ...state.settings }),
    setSettingsDurable: (patch, options = {}) => {
      const previous = state.settings;
      state.settings = { ...state.settings, ...(patch || {}) };
      try {
        if (typeof options.beforePersist === 'function') options.beforePersist();
        if (base.persistNow()) return { ...state.settings };
      } catch (_) {}
      state.settings = previous;
      return null;
    },
    persist: () => true,
    persistNow: () => true,
    pruneHistory: () => {},
    bumpHistoryViewRevision: () => {},
    scheduleFlush: () => { flushes++; },
    hostToContainer: (p) => path.resolve(String(p)),
    containerToHost: (p) => path.resolve(String(p)),
    assertRealWithin: async (parent, target) => {
      const p = path.resolve(parent) + path.sep;
      const t = path.resolve(target);
      if (t !== path.resolve(parent) && !t.startsWith(p)) throw new Error('outside-root');
      return t;
    },
    resolveWithin: (parent, sub) => {
      const t = path.resolve(parent, String(sub || ''));
      const p = path.resolve(parent) + path.sep;
      if (t !== path.resolve(parent) && !t.startsWith(p)) throw new Error('outside-root');
      return t;
    },
    folderMetrics: async (target) => {
      let bytes = 0, files = 0;
      const walk = async (dir) => {
        for (const ent of await fs.promises.readdir(dir, { withFileTypes:true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await walk(full);
          else if (ent.isFile()) { const st = await fs.promises.stat(full); bytes += st.size; files++; }
        }
      };
      await walk(target);
      return { bytes, files };
    },
    resolveHostItem: async (p) => {
      const st = await fs.promises.stat(p);
      return { hostPath:p, name:path.basename(p), size:st.isFile() ? st.size : null, type:st.isDirectory() ? 'folder' : 'file' };
    },
    getAccountById: (id) => id === account.id ? account : null,
    findAccountByName: (name) => name === account.username ? account : null,
    currentAccount: () => account,
    activityPrincipal: () => ({ accountId:account.id }),
    clientIp: (req) => req && req.ip || '203.0.113.9',
    maskIp: (ip) => String(ip).replace(/\.\d+$/, '.x'),
    pubIp: (ip) => ip,
    validDownloadResumeId: (v) => /^[A-Za-z0-9_-]{4,}$/.test(String(v || '')) ? String(v) : null,
    pruneDownloadResumeSessions: () => ({}),
    ...overrides,
  };
  const service = createShareService(base);
  return { service, root, inbox, pending, enc, account, get state() { return state; }, setState(next) { state = next; }, get flushes() { return flushes; } };
}

test('point 9 share domain is owned by a dedicated service', () => {
  const server = read('server.js');
  const service = read('lib/server/share-service.js');
  const composition = read('lib/server/share-media-transfer-application.js');
  assert.match(server, /createShareMediaTransferApplication/);
  assert.match(composition, /createShareService/);
  assert.match(composition, /applicationContext\.bind\(shareService, SHARE_FACADE_METHODS\)/);
  assert.match(composition, /\['share', shareService\]/);
  assert.match(composition, /SHARE_FACADE_METHODS[\s\S]*?['"]runExpiredLinkLifecycle['"]/);
  assert.doesNotMatch(server, /function runExpiredLinkLifecycle\(\.\.\.args\)/);
  for (const token of ['const byToken = new Map()', 'function destroyShareManagedData', 'function recordRecipientView', 'function ipDownloadQuotaBlocked', 'function performUndo']) {
    assert.match(service, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok(Buffer.byteLength(server, 'utf8') < 450000, `server.js is ${Buffer.byteLength(server, 'utf8')} bytes`);
});

test('share indexes follow root-state replacement and recipient tokens', () => {
  const f = fixture();
  const s1 = f.service.addShare({ type:'secret', name:'one', recipients:[{ token:'recipient_one_1234', name:'Alice' }] }, null, null, false);
  assert.equal(f.service.getById(s1.id), s1);
  assert.equal(f.service.getByToken('recipient_one_1234'), s1);
  assert.equal(f.service.recipientByToken.get('recipient_one_1234').recipient.name, 'Alice');

  const s2 = { id:'bbbbbbbbbbbbbbbb', token:'share_two_token_1234', type:'secret', name:'two', recipients:[] };
  f.setState({ ...f.state, shares:[s2], trash:[] });
  f.service.reindex();
  assert.equal(f.service.getById(s1.id), undefined);
  assert.equal(f.service.getByToken(s2.token), s2);
  assert.equal(f.service.recipientByToken.has('recipient_one_1234'), false);
});

test('restore regenerates conflicting ids/tokens without corrupting indexes', () => {
  const f = fixture();
  const live = f.service.addShare({ type:'secret', name:'live', recipients:[{ token:'recipient_live_1234', name:'Live' }] }, null, null, false);
  const trashed = {
    id:'trashrec00000001', deletedAt:Date.now(),
    share:{ id:live.id, token:live.token, type:'secret', name:'restored', recipients:[{ token:'recipient_live_1234', name:'R' }] },
  };
  f.state.trash.push(trashed);
  const restored = f.service.restoreTrashRecord(trashed);
  assert.notEqual(restored.id, live.id);
  assert.notEqual(restored.token, live.token);
  assert.notEqual(restored.recipients[0].token, 'recipient_live_1234');
  assert.equal(f.service.getById(restored.id), restored);
  assert.equal(f.service.getByToken(restored.recipients[0].token), restored);
});

test('expiry and visitor quota rules are centralized and bounded', () => {
  const f = fixture({ logAudit:() => {}, noteCenterAutoDisabled:() => {} });
  const now = Date.now();
  const s = f.service.addShare({ type:'secret', name:'quota', firstUsedAt:now - 10_000, firstUseExpirySeconds:5, maxVisitors:2 }, null, null, false);
  assert.ok(f.service.shareEffectiveExpiry(s) <= now - 5_000 + 10);
  assert.equal(f.service.isActive(s, now), false);
  delete s.firstUsedAt; delete s.firstUseExpirySeconds;
  assert.equal(f.service.recordAndCheckVisitor(s, { ip:'203.0.113.1' }), true);
  assert.equal(f.service.recordAndCheckVisitor(s, { ip:'203.0.114.2' }), true);
  assert.equal(f.service.recordAndCheckVisitor(s, { ip:'203.0.115.3' }), false);
  assert.equal(s.revoked, true);
  assert.equal(s.visitors.length, 2);
  assert.equal(f.service.parseMaxVisitors(Number.MAX_SAFE_INTEGER), f.service.constants.VISITORS_MAX);
});

test('managed inbox data is purged only after the last share reference disappears', async () => {
  const f = fixture();
  const rel = 'shared-inbox';
  const dir = path.join(f.inbox, rel);
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'abc');
  const a = f.service.addShare({ type:'inbox', relDir:rel, name:'a' }, null, null, false);
  const b = f.service.addShare({ type:'collab', relDir:rel, name:'b' }, null, null, false);
  await f.service.destroyShareManagedData(a);
  assert.equal(fs.existsSync(dir), true);
  f.service.detachActiveShare(a);
  f.service.detachActiveShare(b);
  await f.service.destroyShareManagedData(b);
  assert.equal(fs.existsSync(dir), false);
});

test('durable share-assignment undo refuses stale state and restores matching state', () => {
  const f = fixture();
  const share = f.service.addShare({ type:'secret', name:'after' }, null, null, false);
  const req = { session:{ accountId:f.account.id, username:f.account.username, role:'owner' } };
  const entry = f.service.recordUndoable(req, 'rename', 'rename share', {
    kind:'share-assign', shareId:share.id, set:{ name:'before' }, expect:{ name:'after' },
  });
  assert.equal(f.service.undoAvailability(entry).canUndo, true);
  const result = f.service.performUndo(entry, req);
  assert.equal(result.ok, true);
  assert.equal(share.name, 'before');
  assert.equal(entry.undone, true);

  const stale = f.service.recordUndoable(req, 'rename', 'stale', {
    kind:'share-assign', shareId:share.id, set:{ name:'x' }, expect:{ name:'different' },
  });
  assert.deepEqual(f.service.undoAvailability(stale), { canUndo:false, reason:'state-changed' });
});

test('settings undo delegates its atomic commit and retention hook to settings-service', () => {
  let observedRetention = null;
  let f = null;
  f = fixture({
    pruneHistory:() => {
      observedRetention = f.state.settings.historyRetentionDays;
      f.state.history = [];
    },
  });
  f.state.settings = { ...f.state.settings, brandName:'After', historyRetentionDays:0 };
  f.state.history = [{ id:'old', endedAt:1 }];
  const req = { session:{ accountId:f.account.id, username:f.account.username, role:'owner' } };
  const entry = f.service.recordUndoable(req, 'settings-changed', 'settings', {
    kind:'settings',
    before:{ brandName:'Before', historyRetentionDays:1 },
    after:{ brandName:'After', historyRetentionDays:0 },
  });

  const result = f.service.performUndo(entry, req);
  assert.equal(result.ok, true);
  assert.equal(f.state.settings.brandName, 'Before');
  assert.equal(f.state.settings.historyRetentionDays, 1);
  assert.equal(observedRetention, 1);
  assert.deepEqual(f.state.history, []);
  assert.equal(entry.undone, true);
});

test('expired-link housekeeping purges expired metadata links and reindexes', async () => {
  const events = [];
  const f = fixture({
    emitLiveActivity:(kind, data) => events.push([kind, data]),
    logAudit:() => {},
    addAdminCenterNotification:() => {},
    scheduleSearchReindex:() => events.push(['reindex']),
  });
  f.state.settings.expiredDataRetentionDays = 1;
  const share = f.service.addShare({ type:'secret', name:'old', expiresAt:Date.now() - 3 * 86400000 }, null, null, false);
  const result = await f.service.runExpiredLinkLifecycle(Date.now());
  assert.equal(result.purged, 1);
  assert.equal(f.service.getById(share.id), undefined);
  assert.equal(f.state.shares.length, 0);
  assert.ok(events.some(([kind]) => kind === 'trash'));
});

test('per-IP download quota honors an active resume session without spending a second slot', () => {
  const sessions = { resume_1234:{ shareId:'s1', finalized:false } };
  const f = fixture({ pruneDownloadResumeSessions:() => sessions });
  const share = { id:'s1', maxDownloadsPerIp:1, ipDownloads:{ '203.0.113.x':1 } };
  const resumed = { method:'GET', ip:'203.0.113.7', headers:{ 'x-direct-xfer-resume-id':'resume_1234' } };
  const fresh = { method:'GET', ip:'203.0.113.7', headers:{} };
  assert.equal(f.service.ipDownloadQuotaBlocked(share, resumed), false);
  assert.equal(f.service.ipDownloadQuotaBlocked(share, fresh), true);
});

test('main share tokens cannot be shadowed by a colliding recipient token', () => {
  const f = fixture();
  const main = { id:'main000000000001', token:'shared_token_1234', type:'secret', name:'main', recipients:[] };
  const other = { id:'other00000000001', token:'other_token_1234', type:'secret', name:'other', recipients:[{ token:'shared_token_1234', name:'Collision' }] };
  f.setState({ ...f.state, shares:[main, other] });
  f.service.reindex();
  assert.equal(f.service.getByToken('shared_token_1234'), main);
  assert.equal(f.service.recipientByToken.has('shared_token_1234'), false);
});

test('root-state reset invalidates logical/backing caches before reindexing restored shares', () => {
  const f = fixture();
  f.service.shareLogicalBytesCache.set('old', { at:Date.now(), bytes:99, files:1 });
  f.service.shareBackingHealthCache.set('old', { at:Date.now(), available:true });
  const restored = { id:'restored00000001', token:'restored_token_1234', type:'secret', name:'restored' };
  f.setState({ ...f.state, shares:[restored], trash:[] });
  f.service.clearRuntimeState();
  assert.equal(f.service.shareLogicalBytesCache.size, 0);
  assert.equal(f.service.shareBackingHealthCache.size, 0);
  assert.equal(f.service.getById(restored.id), restored);
});


test('new shares cannot overwrite an existing id, main token, or recipient token', () => {
  const f = fixture();
  const first = f.service.addShare({
    id:'aaaaaaaaaaaaaaaa', token:'main_token_1234', type:'secret', name:'first',
    recipients:[{ token:'recipient_token_1234', name:'Alice' }],
  }, null, null, false);
  const second = f.service.addShare({
    id:first.id, token:first.token, type:'secret', name:'second',
    recipients:[{ token:'recipient_token_1234', name:'Bob' }],
  }, null, null, false);

  assert.notEqual(second.id, first.id);
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.recipients[0].token, 'recipient_token_1234');
  assert.equal(f.service.getById(first.id), first);
  assert.equal(f.service.getByToken(first.token), first);
  assert.equal(f.service.getByToken('recipient_token_1234'), first);
  assert.equal(f.service.getById(second.id), second);
  assert.equal(f.service.getByToken(second.token), second);
});

test('root replacement cannot resurrect a stale logical-size scan for a reused share id', async () => {
  let release;
  const metrics = new Promise((resolve) => { release = resolve; });
  const f = fixture({ folderMetrics: async () => metrics });
  const dir = path.join(f.root, 'folder');
  fs.mkdirSync(dir, { recursive:true });
  const old = f.service.addShare({ id:'same-share-id', token:'old_token_1234', type:'folder', hostPath:dir, name:'old' }, null, null, false);
  const job = f.service.queueShareLogicalBytesRefresh(old);
  await new Promise((resolve) => setImmediate(resolve));

  const replacement = { id:'same-share-id', token:'new_token_1234', type:'secret', name:'new' };
  f.setState({ ...f.state, shares:[replacement], trash:[] });
  f.service.clearRuntimeState();
  release({ bytes:987654, files:12 });
  await job;

  assert.equal(f.service.getById('same-share-id'), replacement);
  assert.equal(f.service.shareLogicalBytesCache.has('same-share-id'), false);
});

test('root replacement suppresses stale async GeoIP callbacks from the previous share state', async () => {
  let release;
  const geo = new Promise((resolve) => { release = resolve; });
  const countries = [];
  const f = fixture({
    geoSync: () => null,
    geolocate: async () => geo,
    noteCenterCountry: (share, _ip, row) => { if (row && row.country) countries.push([share.id, row.country]); },
  });
  const old = f.service.addShare({ id:'same-geo-id', token:'geo_old_1234', type:'secret', name:'old' }, null, null, false);
  f.service.bumpViews(old, { ip:'203.0.113.9' });

  const replacement = { id:'same-geo-id', token:'geo_new_1234', type:'secret', name:'new' };
  f.setState({ ...f.state, shares:[replacement], trash:[] });
  f.service.clearRuntimeState();
  release({ country:'Canada', countryCode:'CA' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(countries, []);
});

test('managed purge never stats or deletes encrypted/pending paths outside their managed roots', async () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside.dxe');
  fs.writeFileSync(outside, 'do-not-delete');
  const share = f.service.addShare({ id:'unsafe-share-id', token:'unsafe_token_1234', type:'file', encrypted:true, encPath:outside, name:'unsafe' }, null, null, false);
  f.state.meta.pending = [{ id:'../outside.dxe', shareId:share.id }];

  const availability = await f.service.shareReactivationAvailability(share);
  assert.equal(availability.available, false);
  const impact = await f.service.trashManagedPurgeMetrics(share);
  assert.equal(impact.bytes, 0);
  await f.service.destroyShareManagedData(share);
  assert.equal(fs.existsSync(outside), true);
});

test('managed ciphertext inside ENC_DIR is still detected and deleted normally', async () => {
  const f = fixture();
  const managed = path.join(f.enc, 'managed.dxe');
  fs.writeFileSync(managed, 'ciphertext');
  const share = f.service.addShare({ id:'managed-share-id', token:'managed_token_1234', type:'file', encrypted:true, encPath:managed, name:'managed' }, null, null, false);

  assert.equal((await f.service.shareReactivationAvailability(share)).available, true);
  assert.equal((await f.service.trashManagedPurgeMetrics(share)).bytes, Buffer.byteLength('ciphertext'));
  await f.service.destroyShareManagedData(share);
  assert.equal(fs.existsSync(managed), false);
});

test('state restore is reported busy while managed-data destruction is in flight', async () => {
  const f = fixture();
  const rel = 'busy-inbox';
  const dir = path.join(f.inbox, rel);
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const share = f.service.addShare({ type:'inbox', relDir:rel, name:'busy' }, null, null, false);

  const deletion = f.service.destroyShareManagedData(share);
  assert.equal(f.service.isBusyForStateReplacement(), true);
  await deletion;
  assert.equal(f.service.isBusyForStateReplacement(), false);
  assert.match(read('lib/server/state-lifecycle-application.js'), /\['share-http', \(\) => shareMediaTransferApplication\.isBusyForStateReplacement\(\)[\s\S]*callLate\(publicHttpProvider, 'publicHttpApplication', 'isBusyForStateReplacement'\)\]/);
  assert.match(read('lib/server/restore-service.js'), /function restoreIsBusy\(\)[\s\S]*stateReplacementCoordinator\.isBusyForStateReplacement\(\)/);
});

test('numeric share counters recover from string-valued restored state', () => {
  const f = fixture();
  const share = f.service.addShare({ type:'secret', name:'numeric', views:'9', bytesServed:'10' }, null, null, false);
  f.service.bumpViews(share, { ip:'203.0.113.9' });
  f.service.noteBytesServed(share.id, 5);
  assert.equal(share.views, 10);
  assert.equal(share.bytesServed, 15);
});

test('managed purge rejects symlink-parent escapes for encrypted, pending, and inbox storage', async (t) => {
  const realAssertWithin = async (parent, target) => {
    const realParent = await fs.promises.realpath(parent);
    const realTarget = await fs.promises.realpath(target);
    const rel = path.relative(realParent, realTarget);
    if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) return realTarget;
    const e = new Error('outside-root'); e.code = 'EPATH'; throw e;
  };
  const f = fixture({ assertRealWithin: realAssertWithin });
  const outside = path.join(f.root, 'outside-managed');
  const outsideSub = path.join(outside, 'subdir');
  fs.mkdirSync(outsideSub, { recursive:true });
  const cipher = path.join(outside, 'cipher.bin');
  const pendingFile = path.join(outside, 'pending.bin');
  const inboxFile = path.join(outsideSub, 'keep.txt');
  fs.writeFileSync(cipher, 'cipher');
  fs.writeFileSync(pendingFile, 'pending');
  fs.writeFileSync(inboxFile, 'inbox');
  try {
    fs.symlinkSync(outside, path.join(f.enc, 'jump'), 'dir');
    fs.symlinkSync(outside, path.join(f.pending, 'jump'), 'dir');
    fs.symlinkSync(outside, path.join(f.inbox, 'jump'), 'dir');
  } catch (e) {
    if (e && ['EPERM','EACCES','ENOTSUP'].includes(e.code)) return t.skip('directory symlinks unavailable');
    throw e;
  }
  const share = f.service.addShare({
    id:'symlink-escape-share', token:'symlink_escape_1234', type:'inbox', name:'unsafe restore',
    encrypted:true, encPath:path.join(f.enc, 'jump', 'cipher.bin'), relDir:'jump/subdir',
  }, null, null, false);
  f.state.meta.pending = [{ id:'jump/pending.bin', shareId:share.id }];
  const impact = await f.service.trashManagedPurgeMetrics(share);
  assert.equal(impact.bytes, 0);
  await f.service.destroyShareManagedData(share);
  assert.equal(fs.readFileSync(cipher, 'utf8'), 'cipher');
  assert.equal(fs.readFileSync(pendingFile, 'utf8'), 'pending');
  assert.equal(fs.readFileSync(inboxFile, 'utf8'), 'inbox');
});
