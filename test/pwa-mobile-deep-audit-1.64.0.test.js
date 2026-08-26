'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=(f)=>fs.readFileSync(path.join(root,f),'utf8');
const app=read('pwa/app.js'), sw=read('pwa/sw.js'), mobile=read('pwa/mobile-intelligence.js');

test('1.71.14 release and pwa477 are synchronized',()=>{
  assert.match(read('package.json'),/"version"\s*:\s*"1\.71\.14"/);
  for(const f of ['pwa/app.js','pwa/index.html','pwa/sw.js','pwa/theme-init.js','pwa/admin-advanced.js','pwa/mobile-intelligence.js']) assert.match(read(f),/1\.71\.14|pwa477|v=458/);
  assert.doesNotMatch(read('pwa/index.html')+read('pwa/sw.js'),/pwa324|v=324/);
});

test('background sync persists and enforces Wi-Fi transport policy',()=>{
  assert.match(app,/wifiRequired:\s*!!it\.wifiRequired/);
  assert.match(app,/item\.wifiRequired\s*=\s*wifiPolicyRequired\(item\)/);
  assert.match(app,/function persistWifiPolicies\(/);
  assert.match(sw,/function bgWifiAllowed\(record\)/);
  assert.match(sw,/var transportable = eligible\.filter\(bgWifiAllowed\)/);
  assert.match(sw,/if \(!c \|\| !c\.type\) return false/);
});

test('automatic network benchmark excludes files currently blocked by Wi-Fi policy',()=>{
  const start=app.indexOf('async function maybeTestNetworkForLargeTransfer');
  const end=app.indexOf('// Upload protocol',start);
  const fn=app.slice(start,end);
  assert.match(fn,/filter\(function \(it\) \{ return !wifiPolicyRequired\(it\) \|\| wifiOk\(it\); \}\)/);
});

test('adaptive concurrency is enforced between chunks via an atomic slot counter',()=>{
  assert.match(app,/async function acquireAdaptiveTransferSlot\(/);
  assert.match(app,/networkActiveTransfers < limit/);
  assert.match(app,/networkActiveTransfers\+\+/);
  assert.match(app,/await acquireAdaptiveTransferSlot\(\)/);
  assert.match(app,/finally \{ releaseAdaptiveTransferSlot\(\); \}/);
});

test('background transfer progress notification follows persisted user preference',()=>{
  assert.match(app,/metaSet\('transferNotificationEnabled', !!enabled\)/);
  assert.match(sw,/bgMetaGet\(db, 'transferNotificationEnabled', true\)/);
  assert.match(sw,/bgUploadOne\(db, transportable\[i\], notifyProgress, notifyLang, aggregate\)/);
  assert.match(sw,/if\s*\(notifyProgress\).*showActiveTransferNotification/);
});

test('timeline and widget have bounded IDB/race handling and privacy-name redaction',()=>{
  assert.match(mobile,/req\.onblocked = function\(\)\{ finish\(\[\]\); \}/);
  assert.match(mobile,/setTimeout\(function\(\)\{finish\(\[\]\);\},4500\)/);
  assert.match(mobile,/timelinePromise/);
  assert.match(mobile,/widgetPromise/);
  assert.match(mobile,/privacyNamesEnabled/);
  assert.match(mobile,/privateItem/);
});

test('voice search cleans up microphone lifecycle and joins multiple recognition results with spaces',()=>{
  assert.match(mobile,/parts\.join\(' '\)/);
  assert.match(mobile,/code==='aborted'/);
  assert.match(mobile,/code==='no-speech'/);
  assert.match(mobile,/visibilitychange/);
  assert.match(mobile,/recognition\.stop\(\)/);
});

test('quick widget dialog has accessibility label, escape close and stale refresh cancellation',()=>{
  assert.match(mobile,/aria-labelledby="dx-widget-title"/);
  assert.match(mobile,/aria-label="'\+esc\(tr\('widgetClose'\)\)/);
  assert.match(mobile,/e\.key==='Escape'/);
  assert.match(mobile,/widgetSeq\+\+/);
  assert.match(mobile,/seq!==widgetSeq/);
});

test('pause/resume notification preserves the last real progress payload',()=>{
  assert.match(app,/transferNotificationLastPayload/);
  assert.match(app,/Object\.assign\(\{\}, transferNotificationLastPayload \|\| \{\}, message \|\| \{\}\)/);
  assert.match(app,/transferNotificationLastPayload = null/);
});

test('ETA timing uses a monotonic browser clock',()=>{
  const start=app.indexOf('function emaRate('), end=app.indexOf('function fmtBytes',start);
  const fn=app.slice(start,end);
  assert.match(fn,/performance\.now\(\)/);
});

test('background progress is aggregate across the eligible durable queue',()=>{
  assert.match(sw,/aggregateTotal=transportable\.reduce/);
  assert.match(sw,/completedBytes/);
  assert.match(sw,/bgUploadOne\(db, transportable\[i\], notifyProgress, notifyLang, aggregate\)/);
});

test('privacy toggle clears newly added timeline/widget surfaces immediately',()=>{
  assert.match(mobile,/privacyToggle\.addEventListener\('change'/);
  assert.match(mobile,/timelineCache=\[\];renderTimeline\(\)/);
  assert.match(mobile,/dx-widget-recent/);
});


test('Wi-Fi-only enforcement fails closed and is rechecked between background chunks',()=>{
  assert.match(app,/if \(!c \|\| !c\.type\) return false/);
  assert.doesNotMatch(app,/type === 'unknown'/);
  assert.match(sw,/while \(offset < uploadSize\) \{[\s\S]*?if \(!bgWifiAllowed\(record\)\) throw new Error\('background-wifi-required'\)/);
});

test('background notification failures never abort the upload transport',()=>{
  assert.match(sw,/try \{ await showActiveTransferNotification\(\{sent:sent[\s\S]*?\} catch \(_\) \{\}/);
  assert.match(sw,/if\(notifyProgress\) try \{ await showActiveTransferNotification/);
});

test('background aggregate excludes Wi-Fi-blocked records from moving progress',()=>{
  assert.match(sw,/var transportable = eligible\.filter\(bgWifiAllowed\)/);
  assert.match(sw,/aggregateTotal=transportable\.reduce/);
  assert.match(sw,/retry = transportable\.length !== eligible\.length/);
});

test('shortcut manifests use the current pwa477 cache buster on app and login paths',()=>{
  assert.match(app,/manifestHref = '\/direct-xfer-pwa\.webmanifest\?v=458'/);
  assert.match(read('pwa/login.html'),/direct-xfer-pwa\.webmanifest\?v=458/);
});
