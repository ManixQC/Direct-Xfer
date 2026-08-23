'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPhotoService } = require('../lib/server/photo-service');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function makeHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-photo-service-'));
  const data = path.join(tmp, 'data');
  const root = path.join(tmp, 'host');
  const imageStore = path.join(data, 'images-v2');
  const dirs = {
    HOST_ROOT: root,
    IMAGE_STORE_DIR: imageStore,
    FULL_IMAGES_DIR: path.join(imageStore, 'Full'),
    THUMBS_DIR: path.join(imageStore, 'Mini'),
    MICROS_DIR: path.join(imageStore, 'Micro'),
    PHOTO_HISTORY_DIR: path.join(imageStore, 'History'),
    PHOTO_VERSIONS_DIR: path.join(imageStore, 'Versions'),
    ADAPTIVE_IMAGES_DIR: path.join(imageStore, 'Adaptive'),
    LEGACY_IMAGES_DIR: path.join(data, 'images'),
    LEGACY_THUMBS_DIR: path.join(data, 'thumbs'),
    LEGACY_MICROS_DIR: path.join(data, 'micros'),
    LEGACY_PHOTO_HISTORY_DIR: path.join(data, 'photo-history'),
  };
  for (const dir of Object.values(dirs)) {
    if (dir === root) continue;
    fs.mkdirSync(dir, { recursive:true });
  }
  fs.mkdirSync(root, { recursive:true });
  const state = { shares:[], trash:[], photoHistory:[] };
  const service = createPhotoService({
    ...dirs,
    PHOTO_HISTORY_MAX: 50,
    getState: () => state,
    listShares: () => state.shares,
    trashItems: () => state.trash,
    hostToContainer: (p) => path.resolve(String(p)),
    assertRealWithin: async (base, candidate) => {
      const rootAbs = path.resolve(base) + path.sep;
      const abs = path.resolve(candidate);
      if (!(abs + path.sep).startsWith(rootAbs) && !abs.startsWith(rootAbs)) {
        const e = new Error('outside-root'); e.code = 'outside-root'; throw e;
      }
      return abs;
    },
    ownsShare: () => true,
    canManagePwaImage: () => true,
    decorateShare: (photo) => ({ id:photo.id, token:photo.token, name:photo.name }),
    getSettings: () => ({ imageBase:'https://img.example.test' }),
    primaryBase: () => 'https://main.example.test',
    isActive: () => true,
    shareEffectiveExpiry: (photo) => photo.expiresAt || null,
    persist: async () => true,
    persistNow: () => true,
  });
  return { tmp, state, service, ...dirs };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

test('1.69.6 photo domain is extracted behind photo-service', () => {
  const server = read('server.js');
  const service = read('lib/server/photo-service.js');
  assert.match(server, /createPhotoService/);
  assert.match(server, /photoService = createPhotoService/);
  for (const name of ['uniquePhotoPaths','photoStatsOf','analyzePhotoDuplicates','archiveCurrentPhotoVersion','pwaPhotoPayload']) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\b`), `${name} should not live in server.js`);
    assert.match(service, new RegExp(`function\\s+${name}\\b`));
  }
  assert.ok(fs.statSync(path.join(ROOT, 'server.js')).size < 750000, 'server.js should remain substantially below the pre-refactor size');
  assert.match(read('windows-server-host/Program.cs'), /lib\/server\/photo-service\.js/);
});

test('managed image paths reject traversal-shaped names and tokens', () => {
  const h = makeHarness();
  try {
    assert.deepEqual(h.service.photoOriginalPaths({ imgPath:'../escape.jpg' }), []);
    assert.deepEqual(h.service.photoVariantPaths('../bad', 'thumb'), []);
    assert.equal(h.service.photoAdaptivePath('../bad', 'webp'), null);
    const token = 'abcdefghijklmnop';
    const paths = h.service.photoVariantPaths(token, 'thumb');
    assert.ok(paths.every((p) => path.resolve(p).startsWith(path.resolve(h.THUMBS_DIR)) || path.resolve(p).startsWith(path.resolve(h.LEGACY_THUMBS_DIR))));
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('photo history normalization stays bounded and privacy-safe', () => {
  const h = makeHarness();
  try {
    const rows = Array.from({ length:60 }, (_, i) => ({
      id:(i.toString(16).padStart(16, '0')).slice(-16),
      name:'photo\n' + i,
      ext:i % 2 ? 'JPG' : '../../exe',
      fullViews:-5,
      thumbVisitors:1.8,
      preview:true,
    }));
    const normalized = h.service.normalizePhotoHistory(rows);
    assert.equal(normalized.length, 50);
    assert.equal(normalized[0].name.includes('\n'), false);
    assert.equal(normalized[0].ext, 'jpg');
    assert.equal(normalized[0].fullViews, 0);
    assert.equal(normalized[0].thumbVisitors, 1);
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('unique visitor cache follows the durable visitor array after replacement', () => {
  const h = makeHarness();
  try {
    const stats = { u:['10.0.0.1'] };
    const first = h.service.photoVisitorSet(stats);
    assert.equal(first.has('10.0.0.1'), true);
    stats.u = ['10.0.0.2'];
    const second = h.service.photoVisitorSet(stats);
    assert.notEqual(second, first);
    assert.equal(second.has('10.0.0.1'), false);
    assert.equal(second.has('10.0.0.2'), true);
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('photo version archive and restore preserve bytes and invalidate live variants', () => {
  const h = makeHarness();
  try {
    const token = 'abcdefghijklmnop';
    const originalName = 'current.jpg';
    const originalBytes = Buffer.from('original-photo-bytes');
    fs.writeFileSync(path.join(h.FULL_IMAGES_DIR, originalName), originalBytes);
    fs.writeFileSync(path.join(h.THUMBS_DIR, token + '.jpg'), Buffer.from('thumb-v1'));
    fs.writeFileSync(path.join(h.MICROS_DIR, token + '.jpg'), Buffer.from('micro-v1'));
    const photo = {
      id:'p1', type:'photo', token, imgPath:originalName, name:'photo.jpg', ext:'jpg',
      size:originalBytes.length, contentSha256:sha256(originalBytes), w:800, h:600,
      thumb:true, micro:true, adaptiveWebp:false, cacheRevision:3,
    };
    h.state.shares.push(photo);
    const version = h.service.archiveCurrentPhotoVersion(photo, { reason:'edit', operations:['crop'] });
    assert.ok(version && version.id);
    assert.equal(version.original, true);
    const replacement = Buffer.from('replacement-photo');
    const replacementName = 'replacement.jpg';
    fs.writeFileSync(path.join(h.FULL_IMAGES_DIR, replacementName), replacement);
    photo.imgPath = replacementName;
    photo.size = replacement.length;
    photo.contentSha256 = sha256(replacement);
    photo.w = 320; photo.h = 240; photo.thumb = true; photo.micro = true;
    const tx = h.service.restorePhotoVersion(photo, version);
    assert.ok(tx && tx.newDest);
    assert.deepEqual(fs.readFileSync(tx.newDest), originalBytes);
    assert.equal(photo.contentSha256, sha256(originalBytes));
    assert.equal(photo.w, 800);
    assert.equal(photo.h, 600);
    assert.equal(photo.thumb, undefined);
    assert.equal(photo.micro, undefined);
    assert.ok(photo.cacheRevision > 3);
    assert.ok(Array.isArray(photo.editHistory) && photo.editHistory[0].action === 'restore');
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('duplicate analysis refreshes when photo revision changes even if size and path stay stable', async () => {
  const h = makeHarness();
  try {
    const a = Buffer.from('same-content-0001');
    const b = Buffer.from('same-content-0001');
    assert.equal(a.length, b.length);
    fs.writeFileSync(path.join(h.FULL_IMAGES_DIR, 'a.jpg'), a);
    fs.writeFileSync(path.join(h.FULL_IMAGES_DIR, 'b.jpg'), b);
    const photos = [
      { id:'a', type:'photo', token:'aaaaaaaaaaaaaaaa', imgPath:'a.jpg', name:'a.jpg', size:a.length, cacheRevision:1 },
      { id:'b', type:'photo', token:'bbbbbbbbbbbbbbbb', imgPath:'b.jpg', name:'b.jpg', size:b.length, cacheRevision:1 },
    ];
    const url = (p) => '/i/' + p.token;
    const first = await h.service.analyzePhotoDuplicates(photos, url, url);
    assert.equal(first.duplicateFiles, 1);
    const changed = Buffer.from('diff-content-0001');
    assert.equal(changed.length, b.length);
    fs.writeFileSync(path.join(h.FULL_IMAGES_DIR, 'b.jpg'), changed);
    photos[1].cacheRevision = 2;
    const second = await h.service.analyzePhotoDuplicates(photos, url, url);
    assert.equal(second.duplicateFiles, 0);
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});
