"use strict";
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const app=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public','style.css'),'utf8');
const pwa=fs.readFileSync(path.join(root,'pwa','app.js'),'utf8');

test('creation history receives the request identity and duplicate gets one dedicated creation event',()=>{
  assert.match(server,/function addShare\(share, req = null, creationChange = null, persistAfter = true\)/);
  assert.match(server,/pwaSession && pwaSession\.username/);
  assert.doesNotMatch(server,/\|\| \(s && s\.ownerName\)/);
  assert.match(server,/addShare\(clone, req, \{ action: 'created-from-duplicate'/);
  assert.doesNotMatch(server,/const record = addShare\(clone\);\s*recordShareChange\(record, req, 'created-from-duplicate'/);
});

test('clone drops notification runtime markers so the new link can notify independently',()=>{
  for(const key of ['favorite','firstViewNotifiedAt','firstViewPushPending','firstViewPushQueuedAt','firstViewPushAcceptedAt','downloadThresholdNotifiedAt','centerNotificationCountries','centerViewMilestones','centerDownloadMilestones','centerVisitorAgents','centerExpiredDeadline']) assert.match(server,new RegExp("'"+key+"'"));
});

test('bulk endpoint de-duplicates ids and UI rejects overlapping bulk mutations',()=>{
  assert.match(server,/\[\.\.\.new Set\(b\.ids\.map/);
  assert.match(app,/bulkShareBusy: false/);
  assert.match(app,/if \(state\.bulkShareBusy\) return;/);
  assert.match(app,/finally \{ setShareBulkBusy\(false\); updateBulkBar\(\); \}/);
});

test('auditors cannot see productivity mutation selectors',()=>{
  assert.match(css,/body\[data-role="auditor"\] #bulk-select-page/);
  assert.match(css,/body\[data-role="auditor"\] \.sh-sel/);
  assert.match(css,/body\[data-role="auditor"\] \.share-head-action/);
  assert.match(app,/state\.role === 'auditor' \|\| !!state\.bulkShareBusy/);
});

test('PWA image expiry uses effective lifecycle deadline without overwriting fixed expiry',()=>{
  assert.match(server,/effectiveExpiresAt: effectiveExpiresAt \|\| null/);
  assert.match(pwa,/function imageExpiryDeadline\(photo\)/);
  assert.match(pwa,/effectiveExpiresAt: data\.effectiveExpiresAt \|\| data\.expiresAt \|\| null/);
  assert.match(pwa,/data-expiry-countdown/);
  assert.match(pwa,/photo\.expiresAt \? String\(Math\.max\(1, Math\.round\(\(photo\.expiresAt - Date\.now\(\)\) \/ 1000\)\)\) : '0'/);
});
