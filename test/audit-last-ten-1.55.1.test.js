'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const server = read('server.js');
const admin = read('public', 'app.js');
const pwa = read('pwa', 'app.js');
const resume = read('public', 'media-resume.js');
const textRender = require('../lib/text-render');

test('deep-audit fixes cover preview, DLP, quarantine, dedupe and durable PWA image creation', () => {
  assert.equal(textRender.renderKind('service.cfg'), 'text', '.cfg advertised by the picker must be renderable by the server');
  assert.match(admin, /pk\.previewTruncated/);
  assert.match(admin, /X-Direct-Xfer-Preview-Truncated/);
  assert.match(admin, /dx-admin-media-v2:/);
  assert.match(admin, /mtimeMs/);
  assert.match(pwa, /action === 'quarantine' && \(result\.count \|\| incomplete\)/, 'incomplete local scans must not bypass quarantine');
  assert.match(pwa, /policy\.known && policy\.editable/, 'an admin can preconfigure DLP reactions even while DLP is globally disabled');
  assert.match(pwa, /dlp-quarantined.*dlpServerQuarantined/s);
  assert.match(server, /DLP_QUARANTINE_PERSIST_FAILED/);
  assert.match(server, /dlp-quarantine-failed/);
  assert.doesNotMatch(server, /body\.dlpQuarantineFile/);
  assert.match(server, /DLP_QUARANTINE_SOURCE_INVALID/);
  assert.match(server, /cleanupDlpQuarantineOrphans/);
  assert.match(server, /req\.session \|\| req\.pwaSession/);
  assert.match(server, /function managedPhotoCandidates\(\)/);
  assert.match(server, /trashItems\(\)\.map/);
  assert.match(server, /const rec = addShareDurable\(share, req\);[\s\S]*persisted:false/, 'PWA image create must be durable before returning 201');
});

test('public media resume keeps the old playlist key until new metadata and clears stale positions', () => {
  const store = new Map();
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
  const handlers = Object.create(null);
  const el = {
    currentSrc: 'https://dx.test/a.mp4', src: 'https://dx.test/a.mp4', currentTime: 0, duration: 100,
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const document = { readyState:'complete', querySelectorAll() { return [el]; }, addEventListener() {} };
  const window = { addEventListener() {} };
  const context = { window, document, localStorage, location:{ href:'https://dx.test/s/x', host:'dx.test' }, URL, Date, JSON, Number, isFinite, Array };
  vm.runInNewContext(resume, context, { filename:'media-resume.js' });
  handlers.loadedmetadata();
  el.currentTime = 42; handlers.pause();
  const keyA = [...store.keys()].find(k => k.includes('/a.mp4'));
  assert.ok(keyA, 'first track should be saved');

  // Source changes before the old pause event is delivered: it must still write A.
  el.currentSrc = el.src = 'https://dx.test/b.mp4'; el.currentTime = 43; handlers.pause();
  assert.equal([...store.keys()].some(k => k.includes('/b.mp4')), false);
  handlers.loadedmetadata();
  el.currentTime = 20; handlers.pause();
  const keyB = [...store.keys()].find(k => k.includes('/b.mp4'));
  assert.ok(keyB, 'second track gets its own key after metadata');
  el.currentTime = 0; handlers.pause();
  assert.equal(store.has(keyB), false, 'rewinding clears an old resume point');
  store.set(keyB, JSON.stringify({time:50,at:Date.now()}));
  el.currentTime = 98; handlers.pause();
  assert.equal(store.has(keyB), false, 'near-end playback clears an old resume point');
  store.set(keyB, '{broken');
  handlers.loadedmetadata();
  assert.equal(store.has(keyB), false, 'corrupt resume state is self-healed');
});
