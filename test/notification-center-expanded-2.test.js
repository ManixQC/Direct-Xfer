'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'), std=read('public/app.js'), pwa=read('pwa/app.js');

test('second notification expansion declares all requested event types',()=>{
  const types=['received-file-ready','download-abandoned','upload-abandoned','resume-impossible','protected-link-first-access','password-recovered','visitor-device-new','simultaneous-downloads','high-download-volume','link-viral','link-unused','shared-file-replaced','image-full-replaced','image-variant-regenerated','retention-file-deleted','cleanup-complete','service-unavailable','service-restored','config-save-failed','server-restarted','server-clean-shutdown','server-crash-recovered','public-ip-changed','push-subscription-expired','push-subscription-repaired','push-permission-revoked'];
  for(const type of types){ assert.match(server,new RegExp(`['\"]${type}['\"]`),type); assert.match(std,new RegExp(`['\"]${type}['\"]`),`std ${type}`); assert.match(pwa,new RegExp(`['\"]${type}['\"]`),`pwa ${type}`); }
});

test('transfer, password and visitor hooks are wired',()=>{
  assert.match(server,/function endTransfer[\s\S]*upload-abandoned[\s\S]*download-abandoned[\s\S]*received-file-ready/);
  assert.match(server,/offset-mismatch[\s\S]*resume-impossible/);
  assert.match(server,/function unlockHandler[\s\S]*protected-link-first-access[\s\S]*password-recovered/);
  assert.match(server,/function bumpViews[\s\S]*noteCenterVisitorDevice[\s\S]*noteCenterViral/);
  assert.doesNotMatch(server,/function startTransfer[\s\S]{0,1800}noteCenterConcurrentDownloadStart/);
  assert.match(server,/transfer\.notify = isFullGet[\s\S]{0,180}noteCenterConcurrentDownloadStart\(transfer\)/);
  assert.match(server,/noteCenterHighVolume/);
});

test('image, retention and lifecycle hooks are wired',()=>{
  assert.match(server,/photos\/:id\/replace[\s\S]*image-full-replaced/);
  assert.match(server,/image\/:token\/replace[\s\S]*image-full-replaced/);
  assert.match(server,/image-variant-regenerated/);
  assert.match(server,/function purgeExpiredFiles[\s\S]*retention-file-deleted[\s\S]*noteCenterCleanup/);
  assert.match(server,/function noteCenterLifecycleStart[\s\S]*server-restarted[\s\S]*server-crash-recovered/);
  assert.match(server,/function noteCenterCleanShutdown[\s\S]*clean:true,shutdownAt:now/);
  assert.doesNotMatch(/function noteCenterCleanShutdown[\s\S]*?\n\}/.exec(server)?.[0]||'',/addAdminCenterNotification\('server-clean-shutdown'/);
});

test('service and push recovery hooks are wired',()=>{
  assert.match(server,/function noteCenterServiceState/);
  for(const source of ['geoip','reverse-proxy','web-push','ocr-index','dlp']) assert.match(server,new RegExp(`['\"]${source}['\"]`));
  assert.match(server,/function noteExpiredPushSub[\s\S]*push-subscription-expired/);
  assert.match(server,/push-subscription-repaired/);
  assert.match(server,/app\.post\('\/app\/push\/permission-state'[\s\S]*push-permission-revoked/);
  assert.match(pwa,/\/app\/push\/permission-state/);
});

test('PWA shell is refreshed for the expanded center',()=>{
  assert.match(pwa,/APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa/sw.js'),/VERSION = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa/index.html'),/app\.js\?v=297/);
});

test('GeoIP health tracks provider reachability instead of treating an unlocatable IP as an outage',()=>{
  assert.match(server,/let geoProviderReachable = false/);
  assert.match(server,/geoProviderReachable = !!d/);
  assert.match(server,/noteCenterServiceState\('geoip', geoProviderReachable/);
});

test('viral and high-volume notification trackers are bounded in memory',()=>{
  assert.match(server,/centerVolumeTrackers\.size > 2000[\s\S]*centerVolumeTrackers\.delete/);
  assert.match(server,/centerViralTrackers\.size > 2000[\s\S]*centerViralTrackers\.delete/);
});

test('Push unavailable/restored notifications follow real vendor send results',()=>{
  assert.match(server,/sendNotification[\s\S]*noteCenterServiceState\('web-push-delivery', true, 'Service Push rétabli'/);
  assert.match(server,/noteCenterServiceState\('web-push-delivery', false, `Service Push indisponible/);
});
