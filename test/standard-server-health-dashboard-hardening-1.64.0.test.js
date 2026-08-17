'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'), ui=read('public/server-health-dashboard.js'), html=read('public/index.html'), health=read('lib/pwa-admin-health-route.js');

test('event-loop telemetry keeps a stable observation window across rapid readers', async()=>{
  const h=require('../lib/pwa-admin-health-route');
  await new Promise(r=>setTimeout(r,1100));
  const first=h.eventLoopSnapshot();
  const second=h.eventLoopSnapshot();
  assert.equal(first.supported,true);
  if(first.p95Ms!==null){
    assert.ok(first.p95Ms>0);
    assert.equal(second.p95Ms,first.p95Ms);
    assert.equal(second.cached,true);
  } else {
    assert.equal(first.warming,true);
  }
  h.stopHistorySampler();
});

test('health history accepts the already-sampled payload instead of sampling twice',()=>{
  assert.match(health,/function recordHealthHistory\(force = false, providedHealth = null\)/);
  assert.match(health,/providedHealth \|\| healthPayload\(\)/);
  assert.match(server,/recordHealthHistory\(false, health\)/);
});

test('missing metrics are not coerced to healthy zero values',()=>{
  assert.match(ui,/v===null\|\|v===undefined\|\|v===''/);
  assert.match(ui,/if\(v===null\|\|v===undefined\|\|v===''\)return '—'/);
  assert.match(server,/v === null \|\| v === undefined \|\| v === ''/);
  assert.match(server,/completeness = \{ complete:incomplete\.length === 0/);
});

test('filesystem health probes are asynchronous and bounded',()=>{
  assert.match(server,/async function serverHealthVolume/);
  assert.match(server,/fs\.promises\.lstat/);
  assert.match(server,/fs\.promises\.statfs/);
  assert.match(server,/SERVER_HEALTH_FS_TIMEOUT_MS = 2500/);
  assert.doesNotMatch(server,/function serverHealthVolume[\s\S]{0,1400}lstatSync/);
});

test('storage capacity uses configured thresholds and deduplicates shared filesystems',()=>{
  assert.match(server,/deep\.storage\.thresholds \|\| diskFreeThresholds\(\)/);
  assert.match(server,/const capacityGroups = new Map\(\)/);
  assert.match(server,/volume\.device/);
  assert.match(server,/storage-capacity/);
});

test('connector failures only alert on the recent 24-hour window',()=>{
  assert.match(server,/failedRecent24h/);
  assert.match(server,/recentCutoff = now - 24 \* 60 \* 60 \* 1000/);
  assert.match(server,/connector-failures',deep\.connectors\.jobs\.failedRecent24h/);
});

test('source-health cache is actively warmed by the health dashboard',()=>{
  assert.match(server,/backingChecking:0/);
  assert.match(server,/queueShareBackingHealthRefresh\(sh\)/);
});

test('untrusted forwarding headers are not called a trusted proxy',()=>{
  assert.match(server,/forwardedHeadersPresent/);
  assert.match(server,/proxyDetected:!!\(TRUST_PROXY && forwardedHeadersPresent\)/);
  assert.match(server,/proxy-untrusted/);
});

test('session loss purges privileged System Health data and closes the protected page',()=>{
  assert.match(ui,/function clearSensitive\(\)/);
  assert.match(ui,/\[401,403\]\.includes\(e\.status\)/);
  assert.match(ui,/system-health-btn/);
  assert.match(ui,/closeSystemHealthPage/);
  assert.match(ui,/state\.data=null;state\.diag=null/);
});

test('forced range refresh cannot be lost behind an in-flight request',()=>{
  assert.match(ui,/refreshQueued:true|refreshQueued=false/);
  assert.match(ui,/if\(state\.inFlight\)\{if\(force\)\{state\.refreshQueued=true;state\.seq\+\+;/);
  assert.match(ui,/queueMicrotask\(\(\)=>refresh\(true\)\)/);
});

test('full diagnostics gets a longer timeout than lightweight health polling',()=>{
  assert.match(ui,/\/api\/diagnostics\/run[\s\S]{0,260},30000\)/);
});



test('slow volume probes are single-flight so a dead mount cannot accumulate thread-pool work',()=>{
  assert.match(server,/serverHealthVolumePending = new Map\(\)/);
  assert.match(server,/serverHealthVolumePending\.has\(key\)/);
  assert.match(server,/probe-timeout/);
  assert.match(server,/storage-probe-timeout/);
});

test('share source warming is bounded per health poll',()=>{
  assert.match(server,/SERVER_HEALTH_BACKING_REFRESH_LIMIT = 16/);
  assert.match(server,/let refreshBudget = SERVER_HEALTH_BACKING_REFRESH_LIMIT/);
  assert.match(server,/refreshBudget > 0/);
});

test('automatic health export does not carry raw connector or notification transport errors',()=>{
  assert.match(server,/error:connectorProbe\.capabilities&&connectorProbe\.capabilities\.error\?'unavailable':null/);
  assert.match(server,/lastEmail\.error\?'failed':null/);
  assert.match(server,/lastWebhook\.error\?'failed':null/);
});
test('server health chrome is localized in all three languages and assets are cache-busted',()=>{
  assert.match(html,/server-health-dashboard\.js\?v=4/);
  assert.match(html,/server-health-dashboard\.css\?v=3/);
  assert.match(html,/data-health-text="cpuSystemTitle"/);
  assert.match(html,/data-health-aria="rangeAria"/);
  assert.match(ui,/cpuSystemTitle:'System CPU'/);
  assert.match(ui,/cpuSystemTitle:'CPU del sistema'/);
});
