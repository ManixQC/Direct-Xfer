'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const { createTransferService } = require('../lib/server/transfer-service');
const { createDownloadService } = require('../lib/server/download-service');

test('download and transfer concerns are extracted from the composition root', () => {
  const server = read('server.js');
  const downloads = read('lib/server/download-service.js');
  const transfers = read('lib/server/transfer-service.js');
  const composition = read('lib/server/share-media-transfer-application.js');

  assert.match(server, /createShareMediaTransferApplication\(\{/);
  assert.match(composition, /require\('\.\/download-service'\)/);
  assert.match(composition, /require\('\.\/transfer-service'\)/);
  assert.match(composition, /createDownloadService\(\{/);
  assert.match(composition, /createTransferService\(\{/);
  assert.match(server, /validDownloadResumeId, pruneDownloadResumeSessions/);

  assert.doesNotMatch(server, /class Throttle extends Transform/);
  assert.doesNotMatch(server, /function downloadFileEtag\(/);
  assert.doesNotMatch(server, /function mergeDownloadRanges\(/);
  assert.doesNotMatch(server, /function startTransfer\(/);
  assert.doesNotMatch(server, /function endTransfer\(/);
  assert.doesNotMatch(server, /const activeTransfers = new Map/);

  assert.match(downloads, /class Throttle extends Transform/);
  assert.match(downloads, /function downloadFileEtag\(/);
  assert.match(downloads, /function streamFile\(/);
  assert.match(downloads, /async function streamZip\(/);
  assert.match(downloads, /function serveWebStorageFile\(/);
  assert.match(transfers, /const activeTransfers = new Map\(\)/);
  assert.match(transfers, /function startTransfer\(/);
  assert.match(transfers, /function endTransfer\(/);
});

test('download service keeps ETag, resume-range merging and rate selection deterministic', () => {
  let state = { meta:{} };
  const svc = createDownloadService({
    getState:() => state,
    getSettings:() => ({ globalRateKBps:200, scheduleRateEnabled:false }),
    getById:(id) => id === 's1' ? { id:'s1', rateBps:64 * 1024 } : null,
    startTransfer:() => ({ bytes:0 }),
    endTransfer:() => {},
  });

  const st = { size:1234, mtimeMs:1000, ctimeMs:900, ino:42 };
  assert.equal(svc.downloadFileEtag(st), svc.downloadFileEtag({ ...st }));
  assert.notEqual(svc.downloadFileEtag(st), svc.downloadFileEtag({ ...st, size:1235 }));
  assert.deepEqual(svc.mergeDownloadRanges([[0, 9], [20, 29]], 10, 19), [[0, 29]]);
  assert.equal(svc.downloadRangesComplete([[0, 29]], 30), true);
  assert.equal(svc.downloadRangesCoveredBytes([[0, 9], [5, 14], [20, 29]], 30), 25);
  assert.equal(svc.rateForMeta({ shareId:'s1' }), 64 * 1024, 'tightest per-link/global cap wins');
  assert.equal(svc.rateForMeta({ shareId:'other' }), 200 * 1024);
  assert.equal(svc.validDownloadResumeId('A'.repeat(32)), 'a'.repeat(32));
  assert.equal(svc.validDownloadResumeId('not-a-resume-id'), null);
  state.meta.downloadResumeSessions = { stale:{ updatedAt:0 }, fresh:{ updatedAt:Date.now() } };
  const sessions = svc.pruneDownloadResumeSessions(Date.now());
  assert.equal(sessions.stale, undefined);
  assert.ok(sessions.fresh);
});

test('transfer service owns live state, stop requests and durable byte accounting', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-transfer-service-'));
  try {
    const state = { history:[], stats:{}, settings:{ historyRetentionDays:0 } };
    const shares = new Map([['s1', { id:'s1', name:'Share', type:'file' }]]);
    let presence = 0;
    const svc = createTransferService({
      crypto,
      fs,
      LOG_FILE:path.join(tmp, 'transfers.log'),
      MAX_LOG_BYTES:1024 * 1024,
      HISTORY_MAX:20,
      TRANSFER_STALL_MS:1000,
      getState:() => state,
      getSettings:() => state.settings,
      getById:(id) => shares.get(id) || null,
      clientIp:() => '127.0.0.1',
      geoSync:() => ({ country:'Local network', countryCode:null, flag:'🏠' }),
      geolocate:async () => ({}),
      getRecipientByToken:() => null,
      dataWritable:() => true,
      emitLiveActivity:() => {},
      pubIp:(ip) => ip,
      ipNameFor:() => null,
      schedulePresenceBroadcast:() => { presence++; },
      scheduleFlush:() => {},
      persist:() => {},
      logAudit:() => {},
      addShareCenterNotification:() => null,
      noteCenterCountry:() => {},
      noteCenterActivity:() => {},
      noteCenterRepeatedDownload:() => {},
      noteCenterHighVolume:() => {},
      noteCenterViral:() => {},
      maybeCenterReceptionQuota:() => {},
      noteCenterAutoDisabled:() => {},
      notify:() => {},
      noteLeakSignal:() => {},
    });

    const transfer = svc.startTransfer({ params:{} }, { shareId:'s1', name:'file.bin', type:'file' }, 100);
    assert.equal(svc.activeTransfers.size, 1);
    assert.equal(svc.listTransfers(null)[0].expectedBytes, 100);

    let aborted = 0;
    transfer.abort = () => { aborted++; };
    assert.deepEqual(svc.requestActiveTransferStop(transfer), { ok:true, stopping:true });
    assert.equal(aborted, 1);
    transfer.bytes = 75;
    svc.endTransfer(transfer, false, 'stopped');

    assert.equal(svc.activeTransfers.size, 0);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].bytes, 75);
    assert.equal(state.history[0].reason, 'stopped');
    assert.equal(state.stats.s1.bytes, 75);
    assert.equal(state.stats.s1.interrupted, 1);
    assert.equal(presence, 2);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});


test('local download streaming preserves single-range HTTP semantics and byte telemetry', async () => {
  const { Writable } = require('node:stream');
  const { once } = require('node:events');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-download-service-'));
  try {
    const file = path.join(tmp, 'file.bin');
    fs.writeFileSync(file, Buffer.from('0123456789'));
    const ended = [];
    class Response extends Writable {
      constructor() { super(); this.headers = new Map(); this.statusCode = 200; this.body = []; }
      _write(chunk, _enc, cb) { this.body.push(Buffer.from(chunk)); cb(); }
      setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
      getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
      removeHeader(name) { this.headers.delete(String(name).toLowerCase()); }
      status(code) { this.statusCode = code; return this; }
      type(value) { this.setHeader('Content-Type', value); return this; }
      send(value) { this.end(value); return this; }
      json(value) { this.setHeader('Content-Type', 'application/json'); this.end(JSON.stringify(value)); return this; }
    }
    const svc = createDownloadService({
      getState:() => ({ meta:{} }),
      getSettings:() => ({ globalRateKBps:0, scheduleRateEnabled:false }),
      getById:() => ({ id:'s1', burnAfterDownload:false }),
      maskIp:(ip) => ip,
      clientIp:() => '127.0.0.1',
      scheduleFlush:() => {},
      persistNow:() => true,
      sendError:(_req, res, code) => res.status(code).end(),
      challengeRequired:() => false,
      hasValidPow:() => true,
      challengePage:() => '',
      pickLang:() => 'en',
      noteCenterSharedFileSignature:() => {},
      commitManagedIpDownload:() => {},
      onDownloadComplete:() => {},
      noteBytesServed:() => {},
      startTransfer:(_req, meta, expectedBytes) => ({ ...meta, bytes:0, expectedBytes, startedAt:Date.now(), lastActivity:Date.now() }),
      endTransfer:(transfer, completed, reason) => ended.push({ transfer, completed, reason }),
      noteCenterConcurrentDownloadStart:() => {},
      claimOneTimeDownload:() => null,
      releaseOneTimeDownload:() => {},
    });
    const req = { method:'GET', headers:{ range:'bytes=2-5' }, params:{} };
    const res = new Response();
    svc.streamFile(req, res, file, 'file.bin', null, { shareId:'s1', name:'file.bin', type:'file' });
    await once(res, 'finish');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(res.statusCode, 206);
    assert.equal(res.getHeader('accept-ranges'), 'bytes');
    assert.equal(res.getHeader('content-range'), 'bytes 2-5/10');
    assert.equal(res.getHeader('content-length'), 4);
    assert.match(String(res.getHeader('etag')), /^"dx-/);
    assert.equal(Buffer.concat(res.body).toString(), '2345');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].completed, true);
    assert.equal(ended[0].transfer.bytes, 4);
    assert.equal(ended[0].transfer.notify, false);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});

test('ZIP initialization failures are contained, free the concurrency slot and release one-time claims', async () => {
  const { Writable } = require('node:stream');
  const { once } = require('node:events');
  class Response extends Writable {
    constructor() { super(); this.headers = new Map(); this.statusCode = 200; this.body = []; this.headersSent = false; }
    _write(chunk, _enc, cb) { this.headersSent = true; this.body.push(Buffer.from(chunk)); cb(); }
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
    removeHeader(name) { this.headers.delete(String(name).toLowerCase()); }
    status(code) { this.statusCode = code; return this; }
    type(value) { this.setHeader('Content-Type', value); return this; }
    send(value) { this.end(value); return this; }
    json(value) { this.setHeader('Content-Type', 'application/json'); this.end(JSON.stringify(value)); return this; }
  }
  const finished = async (res) => { if (!res.writableFinished) await once(res, 'finish'); };
  let claims = 0;
  let releases = 0;
  const svc = createDownloadService({
    MAX_CONCURRENT_ZIPS:1,
    getSettings:() => ({ globalRateKBps:0, scheduleRateEnabled:false, maxZipBytes:0 }),
    getById:() => ({ id:'s1', burnAfterDownload:true }),
    startTransfer:() => { throw new Error('transfer must not start when archive initialization fails'); },
    endTransfer:() => {},
    sendError:(_req, res, code) => res.status(code).end('zip-error'),
    claimOneTimeDownload:() => { claims++; return `claim-${claims}`; },
    releaseOneTimeDownload:() => { releases++; },
    zipArchiveFactory:async () => { throw new Error('archiver unavailable'); },
  });

  for (let i = 0; i < 2; i++) {
    const res = new Response();
    await svc.streamZip({ method:'GET', headers:{} }, res, '/unused', 'files', null, { shareId:'s1', name:'files', type:'zip' });
    await finished(res);
    assert.equal(res.statusCode, 500, 'a failed ZIP factory must not turn the next request into a false 429');
  }
  assert.equal(claims, 2);
  assert.equal(releases, 2, 'every failed initialization must release its one-time claim');
});

test('ZIP finalization failure terminates the response instead of leaving an active slot hanging', async () => {
  const { PassThrough, Writable } = require('node:stream');
  const { once } = require('node:events');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-zip-finalize-'));
  class Response extends Writable {
    constructor() { super(); this.headers = new Map(); this.statusCode = 200; this.body = []; this.headersSent = false; }
    _write(chunk, _enc, cb) { this.headersSent = true; this.body.push(Buffer.from(chunk)); cb(); }
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
    removeHeader(name) { this.headers.delete(String(name).toLowerCase()); }
    status(code) { this.statusCode = code; return this; }
    json(value) { this.end(JSON.stringify(value)); return this; }
  }
  const archiveFactory = async () => {
    const archive = new PassThrough();
    archive.append = () => archive;
    archive.finalize = async () => { throw new Error('finalize failed'); };
    archive.abort = () => archive.destroy();
    return archive;
  };
  try {
    const svc = createDownloadService({
      MAX_CONCURRENT_ZIPS:1,
      HOST_ROOT:tmp,
      getSettings:() => ({ globalRateKBps:0, scheduleRateEnabled:false, maxZipBytes:0 }),
      getById:() => null,
      startTransfer:() => null,
      endTransfer:() => {},
      sendError:(_req, res, code) => res.status(code).end('zip-error'),
      claimOneTimeDownload:() => null,
      releaseOneTimeDownload:() => {},
      zipArchiveFactory:archiveFactory,
    });
    const first = new Response();
    await svc.streamZip({ method:'GET', headers:{} }, first, tmp, 'files', null, null);
    if (!first.writableFinished) await once(first, 'finish');
    assert.equal(first.statusCode, 500);

    const second = new Response();
    await svc.streamZip({ method:'GET', headers:{} }, second, tmp, 'files', null, null);
    if (!second.writableFinished) await once(second, 'finish');
    assert.equal(second.statusCode, 500, 'the first failed archive must have released the only ZIP slot');
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});

test('transient transfer cleanup cannot strand a one-time-download claim', () => {
  const state = { history:[], stats:{}, settings:{} };
  const share = { id:'once', name:'Once', type:'file', burnAfterDownload:true, revoked:false };
  const svc = createTransferService({
    crypto,
    fs,
    getState:() => state,
    getSettings:() => state.settings,
    getById:(id) => id === share.id ? share : null,
    clientIp:() => '127.0.0.1',
  });
  const claim = svc.claimOneTimeDownload(share.id);
  assert.equal(typeof claim, 'string');
  const transfer = svc.startTransfer({ params:{} }, { shareId:share.id, name:'fragment', type:'file', transient:true }, 10);
  transfer.burnClaim = claim;
  svc.endTransfer(transfer, false, 'connection-closed');
  assert.notEqual(svc.claimOneTimeDownload(share.id), false, 'transient cleanup must release the old claim');
  assert.equal(state.history.length, 0, 'transient fragments must still stay out of durable history');
});
