'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const reception = fs.readFileSync(path.join(ROOT, 'public', 'reception.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');

test('clones reset runtime quota, dedupe and retention state', () => {
  for (const field of ['receivedHashes','senderStats','ipDownloads','bytesServed','centerFileSignature','centerFileFingerprint','retentionReason','retentionRevokedAt','ownerDeviceId','uploadDeviceName','uploadSource']) {
    assert.match(server, new RegExp("'" + field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'"), `missing clone reset field ${field}`);
  }
});

test('path-aware duplicate hashes are pruned when the stored file disappeared', () => {
  assert.match(server, /function receptionDuplicateStoredPath[\s\S]*fs\.statSync\(target\)[\s\S]*delete s\.receivedHashes\[sha\][\s\S]*scheduleFlush\(\)/);
  assert.match(server, /handleUploadDuplicateCheck[\s\S]*receptionHashSeen\(s, sha\)[\s\S]*receptionDuplicateStoredPath\(s, sha\)/);
});

test('exact replacement can pass logical file, byte and sender quotas but is revalidated', () => {
  assert.match(server, /inboxRejectReason\(s, relForCheck, total, \{ replacingExisting:preflightReplacingExisting \}\)/);
  assert.match(server, /perSenderRejectReason\(s, req, senderName, total, \{ replacingExisting:preflightReplacingExisting \}\)/);
  assert.match(server, /\(s\.bytesReceived \|\| 0\) \+ \(preflightReplacingExisting \? 0 : written\)/);
  assert.match(server, /verifiedSha256 = await hashFileSha256\(part\)/);
  assert.match(server, /finalReason = inboxRejectReason\(s, relForCheck, size, \{ replacingExisting \}\) \|\| perSenderRejectReason/);
});

test('rejectDuplicates remains authoritative over visitor Keep both', () => {
  assert.match(server, /s\.rejectDuplicates && duplicateKnown && \(duplicateAction === 'keep' \|\| \(duplicateAction === 'replace' && !duplicateTarget\)\)/);
  assert.match(reception, /duplicateFoundReject/);
  assert.match(reception, /d\.policy === 'reject'/);
});

test('resume distinguishes full partial from completed upload and fingerprints large files', () => {
  assert.match(reception, /function fetchUploadStatus/);
  assert.match(reception, /if \(st\.complete && o >= size\)/);
  assert.match(reception, /function resumeFingerprint/);
  assert.match(reception, /file\.slice\(0, Math\.min\(sample, file\.size\)\)/);
  assert.match(reception, /sessionBaseBytes/);
  assert.doesNotMatch(reception, /function fetchOffset\(/);
});

test('rolling stats timelines start at the actual cutoff and PWA photo stats use image totals', () => {
  assert.match(server, /bucketMs = 3600000, startAt = cutoff/);
  assert.match(server, /startAt = cutoff;/);
  assert.match(pwa, /image\.totalViews/);
  assert.match(pwa, /image\.totalVisitors/);
  assert.match(pwa, /image\.totalStorageBytes/);
});

test('photo history preserves a true original marker, integrity metadata and deferred storage cleanup', () => {
  assert.match(server, /original:isOriginal/);
  assert.match(server, /contentSha256/);
  assert.match(server, /dlp:/);
  assert.match(server, /function cleanupPhotoVersionStorage/);
  assert.match(server, /cleanupPhotoVersionStorage\(photo\)/);
  assert.match(app, /v\.original/);
  assert.match(pwa, /v\.original/);
});

test('photo visitor totals dedupe the same visitor across image variants', () => {
  assert.match(server, /uniqueImageVisitors\s*=\s*new Set/);
  assert.match(server, /totalVisitors:uniqueImageVisitors\.size/);
});

test('PWA and standard image mutations share transactional write locks', () => {
  assert.match(server, /function handlePhotoAdaptiveUpload/);
  assert.match(server, /adminPhotoVariantWrites/);
  assert.match(server, /adminPhotoFullWrites/);
  assert.match(server, /handleAdminPhotoVariantUpload/);
  assert.match(server, /bumpPhotoCacheRevision/);
  assert.match(server, /persistNow\(\)/);
});
