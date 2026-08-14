'use strict';
// Feature 2 — Background/Periodic Sync. The page performs DLP, transformations
// and encryption before it marks a durable queue entry as background-ready. The
// service worker may then transport those exact bytes while the PWA is closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('pwa/app.js');
const swSource = read('pwa/sw.js');

function fakeIndexedDb(initialRecords) {
  const records = new Map((initialRecords || []).map((record) => [record.id, record]));
  const db = {
    objectStoreNames: { contains: (name) => name === 'queue' },
    createObjectStore: () => {},
    close: () => {},
    transaction() {
      const tx = { error: null };
      const store = {
        getAll() {
          const request = {};
          queueMicrotask(() => { request.result = Array.from(records.values()); if (request.onsuccess) request.onsuccess(); });
          return request;
        },
        put(record) {
          records.set(record.id, record);
          queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
        },
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  return {
    records,
    open() {
      const request = {};
      queueMicrotask(() => { request.result = db; if (request.onsuccess) request.onsuccess(); });
      return request;
    },
  };
}

// Load sw.js in an isolated context with mocked clients, storage and network.
function loadSw({ clients = [], langValue = 'fr', queueRecords = [], fetchImpl } = {}) {
  const notifications = [];
  const handlers = {};
  const indexedDB = fakeIndexedDb(queueRecords);
  const cachesMock = {
    open: async () => ({
      match: async (k) => (k === '/app/__lang' && langValue != null) ? new Response(langValue) : undefined,
      put: async () => {}, delete: async () => {}, keys: async () => [], addAll: async () => {},
    }),
    keys: async () => [], match: async () => undefined, delete: async () => {},
  };
  const self = {
    indexedDB,
    navigator: {},
    crypto: require('node:crypto').webcrypto,
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    registration: { active: null, showNotification: (title, opts) => { notifications.push({ title, opts }); return Promise.resolve(); } },
    clients: { matchAll: async () => clients, openWindow: async () => null, claim: async () => {} },
    location: { origin: 'https://example.test' },
    skipWaiting: () => {},
  };
  const sandbox = {
    self, caches: cachesMock, Response, URL, Blob, TextDecoder, AbortController,
    fetch: fetchImpl || (async () => new Response('', { status: 503 })),
    console, setTimeout, clearTimeout, queueMicrotask, Date, Promise, Math, JSON,
  };
  vm.runInNewContext(swSource, sandbox, { filename: 'sw.js' });
  return { handlers, notifications, records: indexedDB.records };
}
async function fireEvent(env, type, tag) {
  const list = env.handlers[type] || [];
  assert.ok(list.length, `sw.js registers a ${type} handler`);
  let captured = Promise.resolve();
  for (const fn of list) fn({ tag, waitUntil: (p) => { captured = p; } });
  await captured;
}
function readyRecord(id, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  return {
    id, state: 'waiting-network', resumeOnOpen: true, backgroundReady: true,
    snapshot: { token: 'inbox-token', sender: 'Alice', expire: '0' },
    uploadId: `upload-${id}`, upName: `${id}.bin`, upSize: blob.size,
    preparedBlob: blob, preparedType: blob.type, sentBytes: 0,
  };
}

test('a sync wakes an open page instead of racing its active upload queue', async () => {
  const posted = [];
  const env = loadSw({ clients: [{ postMessage: (m) => posted.push(m) }] });
  await fireEvent(env, 'sync', 'dx-resume-uploads');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'RESUME_TRANSFERS');
  assert.equal(env.notifications.length, 0);
});

test('a hidden/frozen PWA client does not consume the sync event without uploading', async () => {
  const posted = [];
  const record = readyRecord('hidden-app', Buffer.from('hidden bytes'));
  const env = loadSw({
    clients: [{ visibilityState: 'hidden', postMessage: (m) => posted.push(m) }],
    queueRecords: [record],
    fetchImpl: async (url) => String(url).includes('/upload-status')
      ? Response.json({ offset: 0 })
      : Response.json({ ok: true }),
  });
  await fireEvent(env, 'sync', 'dx-resume-uploads');
  assert.equal(posted.length, 0, 'a frozen page cannot be delegated the work');
  assert.equal(env.records.get('hidden-app').state, 'done-background');
});

test('with the PWA closed, sync uploads only a pre-approved durable payload', async () => {
  const calls = [];
  const record = readyRecord('closed-app', Buffer.from('prepared encrypted bytes'));
  const env = loadSw({
    langValue: 'en', queueRecords: [record],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if (String(url).includes('/upload-status')) return Response.json({ offset: 0 });
      return Response.json({ ok: true, name: 'closed-app.bin' });
    },
  });
  await fireEvent(env, 'sync', 'dx-resume-uploads');

  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(await calls.find((c) => c.method === 'POST').body.text(), 'prepared encrypted bytes');
  const saved = env.records.get('closed-app');
  assert.equal(saved.state, 'done-background');
  assert.equal(saved.backgroundReady, false);
  assert.equal(saved.preparedBlob, null, 'completed private bytes are released');
  assert.equal(env.notifications.length, 1);
  assert.match(env.notifications[0].opts.body, /completed in the background/);
});

test('a remembered server completion is acknowledged without uploading the file again', async () => {
  const calls = [];
  const record = readyRecord('lost-response', Buffer.from('already committed'));
  const env = loadSw({
    queueRecords: [record],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      return Response.json({ offset: record.upSize, complete: true, response: { ok: true, name: record.upName } });
    },
  });
  await fireEvent(env, 'sync', 'dx-resume-uploads');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'committed bytes must not be posted twice');
  assert.equal(env.records.get('lost-response').state, 'done-background');
});

test('a zero-byte file can finish in the background', async () => {
  const calls = [];
  const record = readyRecord('empty-file', Buffer.alloc(0));
  const env = loadSw({
    queueRecords: [record],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if (String(url).includes('/upload-status')) return Response.json({ offset: 0 });
      return Response.json({ ok: true, name: 'empty-file.bin' });
    },
  });
  await fireEvent(env, 'sync', 'dx-resume-uploads');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'an empty finalize POST is still required');
  assert.equal(post.body.size, 0);
  assert.equal(env.records.get('empty-file').state, 'done-background');
});

test('unapproved and non-durable queue entries are never uploaded by the worker', async () => {
  const calls = [];
  const notReady = readyRecord('not-ready', Buffer.from('secret'));
  notReady.backgroundReady = false;
  const env = loadSw({ queueRecords: [notReady], fetchImpl: async (...args) => { calls.push(args); return new Response(''); } });
  await fireEvent(env, 'sync', 'dx-resume-uploads');
  assert.equal(calls.length, 0);
  assert.equal(env.records.get('not-ready').state, 'waiting-network');
  assert.equal(env.notifications.length, 0);
});

test('periodic sync uses the same closed-app upload path', async () => {
  const record = readyRecord('periodic', Buffer.from('periodic bytes'));
  let posts = 0;
  const env = loadSw({
    langValue: 'fr', queueRecords: [record],
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/upload-status')) return Response.json({ offset: 0 });
      if (options.method === 'POST') posts++;
      return Response.json({ ok: true });
    },
  });
  await fireEvent(env, 'periodicsync', 'dx-periodic-uploads');
  assert.equal(posts, 1);
  assert.equal(env.records.get('periodic').state, 'done-background');
  assert.match(env.notifications[0].opts.body, /arrière-plan/);
});

test('a mixed batch notification reports both completions and failures', async () => {
  const good = readyRecord('mixed-good', Buffer.from('ok'));
  const bad = readyRecord('mixed-bad', Buffer.from('bad'));
  const env = loadSw({
    langValue: 'en', queueRecords: [good, bad],
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/upload-status')) {
        if (String(url).includes('mixed-bad')) return new Response('', { status: 403 });
        return Response.json({ offset: 0 });
      }
      return Response.json({ ok: true });
    },
  });
  await fireEvent(env, 'sync', 'dx-resume-uploads');
  assert.equal(env.notifications.length, 1);
  assert.match(env.notifications[0].opts.body, /completed in the background/);
  assert.match(env.notifications[0].opts.body, /need your attention/);
  assert.equal(env.notifications[0].opts.tag, 'dx-background-mixed');
});

test('an unrelated sync tag is ignored', async () => {
  const posted = [];
  const env = loadSw({ clients: [{ postMessage: (m) => posted.push(m) }] });
  await fireEvent(env, 'sync', 'some-other-tag');
  assert.equal(posted.length, 0);
});

test('the page prepares securely, persists, and registers both recovery mechanisms', () => {
  assert.match(app, /await prepareUpload\(item\)/);
  assert.match(app, /backgroundReady = !!\(\$\('auto-resume'\).*preparedPayloadIsDurable\(it\)\)/);
  assert.match(app, /reg\.sync\.register\('dx-resume-uploads'\)/);
  assert.match(app, /reg\.periodicSync\.register\('dx-periodic-uploads', \{ minInterval: 60 \* 60 \* 1000 \}\)/);
  assert.match(app, /waiting-network'.*schedulePersistItem\(it\); registerBackgroundSync\(\);/);
  assert.match(app, /type === 'RESUME_TRANSFERS'\) maybeAutoResume\(\)/);
  assert.match(app, /type: 'SET_LANG', lang: lang/);
  assert.match(app, /Number\.isFinite\(uploadSize\) \|\| uploadSize < 0/);
});
