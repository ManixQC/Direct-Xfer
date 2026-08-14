'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

test('simultaneous-download alerts only count qualified full downloads',()=>{
  assert.match(server,/function noteCenterConcurrentDownloadStart\(transfer\)[\s\S]*!transfer\.notify/);
  assert.match(server,/activeTransfers\.values\(\)[\s\S]*!t\.notify/);
  assert.doesNotMatch(server,/activeTransfers\.set\(id, t\);\s*if \(transferShare[\s\S]{0,120}noteCenterConcurrentDownloadStart/);
});

test('abandonment is classified only for genuine interrupted transfers',()=>{
  assert.match(server,/const abandoned = !completed[\s\S]*connection-closed[\s\S]*timeout[\s\S]*stopped/);
  assert.match(server,/const primaryType = completed \? 'transfer-complete' : abandoned \?/);
  assert.doesNotMatch(server,/if \(!completed && Number\(t\.bytes \|\| 0\) > 0\)[\s\S]{0,300}abandonedType/);
});

test('moderated reception files are only announced ready after approval',()=>{
  assert.match(server,/if \(pending\.ok\) transfer\.pendingModeration = true;[\s\S]*endTransfer/);
  assert.match(server,/if \(!t\.pendingModeration\) addShareCenterNotification\(centerShare, 'received-file-ready'/);
  assert.match(server,/pending-approved[\s\S]{0,450}received-file-ready[\s\S]{0,200}received-ready:pending/);
});

test('password recovery survives a brute-force lock reset',()=>{
  assert.match(server,/rec\.recoveryFailures = failedCount;\s*rec\.fails = \[\]/);
  assert.match(server,/const previousFailures = Math\.max\([\s\S]*rec\.recoveryFailures/);
});

test('unused-link alert is one notification per inactivity spell',()=>{
  assert.match(server,/startsWith\('unused:'\)\) r\.windowMs = 0/);
  assert.match(server,/dedupeKey:`unused:\$\{s\.id\}:\$\{Math\.floor\(lastUse\/DAY_MS\)\}`\}\);/);
  assert.doesNotMatch(server,/unused:\$\{s\.id\}[\s\S]{0,180}dedupeWindowMs:7\*DAY_MS/);
});

test('shared-file replacement verifies content instead of trusting mtime alone',()=>{
  assert.match(server,/function quickSharedFileFingerprint/);
  assert.match(server,/previousFp && currentFp && previousFp === currentFp/);
  assert.match(server,/same-size mtime change is only a baseline/);
});

test('unclean restart does not report previous uptime as downtime',()=>{
  const block=/function noteCenterLifecycleStart\(\)[\s\S]*?function noteCenterCleanShutdown/.exec(server)?.[0]||'';
  assert.match(block,/server-crash-recovered/);
  assert.doesNotMatch(block,/server-crash-recovered[^\n]*durationMs/);
});

test('public IP detection supports IPv4 and IPv6',()=>{
  assert.match(server,/if \(net\.isIP\(ip\)\)/);
  assert.match(server,/net\.isIP\(ip\) === 6 \? '\[' \+ ip \+ '\]'/);
});

test('Push repair is scoped to the current device, not every device on the account',()=>{
  assert.match(server,/const deviceKey = req\.pwaDevice[\s\S]*'dev:' \+ req\.pwaDevice\.id/);
  assert.match(server,/const priorForDevice = deviceKey \? subs\.filter/);
  assert.doesNotMatch(server,/const priorForOwner = subs\.filter/);
  assert.match(server,/stale\.has\(subs\[j\]\.endpoint\)/);
});

test('Push permission removal is transition-based and retires stale device subscriptions',()=>{
  assert.match(server,/const previous = device && device\.pushPermissionState/);
  assert.match(server,/permission === 'denied' && previous === 'granted'/);
  assert.match(server,/ownerKeys\) && subs\[j\]\.ownerKeys\.includes\(deviceKey\)/);
  assert.match(server,/pushPermissionState = 'granted'/);
});
