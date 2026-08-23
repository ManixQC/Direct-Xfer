'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js');
const service = read('lib/server/upload-reception-service.js');
const routes = read('lib/server/reception-collaboration-routes.js');
const publicShareRoutes = read('lib/server/public-share-routes.js');
const restoreService = read('lib/server/restore-service.js');
const maintenanceService = read('lib/server/maintenance-service.js');

test('1.69.6 upload/reception architecture is split behind explicit boundaries', () => {
  assert.match(server, /createUploadReceptionService/);
  assert.match(server, /attachReceptionCollaborationRoutes/);
  assert.match(server, /const uploadReceptionService = createUploadReceptionService/);
  assert.doesNotMatch(server, /^async function handleUpload\(/m);
  assert.doesNotMatch(server, /^function inboxRejectReason\(/m);
  assert.match(service, /function inboxRejectReason\(/);
  assert.match(routes, /async function handleUpload\(/);
});

test('1.69.6 reception/collaboration route boundary owns the complete writable public surface', () => {
  for (const route of [
    "downloadRouter.get('/u/:token'",
    "downloadRouter.get('/c/:token'",
    "downloadRouter.get('/c/:token/list'",
    "downloadRouter.post('/c/:token/delete'",
    "downloadRouter.post('/u/:token/folder'",
    "downloadRouter.post('/c/:token/folder'",
    "downloadRouter.post('/u/:token/dedupe'",
    "downloadRouter.post('/c/:token/dedupe'",
    "downloadRouter.get('/u/:token/upload-status'",
    "downloadRouter.get('/c/:token/upload-status'",
    "downloadRouter.post('/u/:token/upload-cancel'",
    "downloadRouter.post('/c/:token/upload-cancel'",
    "downloadRouter.post('/u/:token/upload'",
    "downloadRouter.post('/c/:token/upload'",
    "downloadRouter.post('/u/:token/message'",
    "downloadRouter.get('/u/:token/thread'",
    "downloadRouter.post('/u/:token/thread'",
  ]) assert.ok(routes.includes(route), route);
});

test('1.69.6 upload service keeps mutable restore-sensitive state live and hides maintenance counters', () => {
  assert.match(service, /live\.state\.meta/);
  assert.match(server, /live:\s*\{\s*get state\(\) \{ return state; \}/);
  assert.match(service, /function maybeCleanupOrphanPendingFiles/);
  assert.match(server, /runExpiredLinkLifecycle, maybeCleanupOrphanPendingFiles/);
  assert.match(maintenanceService, /maybeCleanupOrphanPendingFiles\(now\)/);
  assert.match(service, /function hasActiveUploads/);
  assert.match(server, /isBackupInFlight:\s*\(\)\s*=>\s*isBackupInFlight\(\)/);
  assert.match(server, /hasActiveUploads:\s*\(\)\s*=>\s*hasActiveUploads\(\)/);
  assert.match(restoreService, /isBackupInFlight\(\)[\s\S]*getActiveTransferCount\(\)[\s\S]*hasActiveUploads\(\)/);
  assert.match(service, /function clearRuntimeAfterRestore/);
  assert.match(server, /clearUploadRuntimeAfterRestore:\s*\(\)\s*=>\s*clearUploadRuntimeAfterRestore\(\)/);
  assert.match(restoreService, /reset\('uploads', clearUploadRuntimeAfterRestore\)/);
});

test('1.69.6 download router signature count remains stable after route extraction', () => {
  const combined = server + '\n' + publicShareRoutes + '\n' + routes;
  const matches = [...combined.matchAll(/downloadRouter\.(get|post|put|delete|patch)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/gs)];
  assert.equal(matches.length, 56);
  const keys = matches.map((m) => `${m[1]}:${m[2].replace(/\s+/g, '')}`);
  assert.equal(new Set(keys).size, keys.length, 'route signatures must remain unique');
});
