'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

test('system subcategory notification targets open Settings/Configuration instead of Activity',()=>{
  const std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(pwa,/\['system','system_health','maintenance','network','restarts','updates','pwa'\]\.indexOf\(cat\)!==-1\) return 'settings'/);
  assert.match(std,/\['system','system_health','maintenance','network','restarts','updates','pwa'\]\.includes\(cat\)\) \{ void openConfigModal\(\); return; \}/);
});

test('one clean restart creates one user-facing restart notification',()=>{
  const server=read('server.js');
  const stop=/function noteCenterCleanShutdown\(signal\) \{[\s\S]*?\n\}/.exec(server)?.[0]||'';
  const start=/function noteCenterLifecycleStart\(\) \{[\s\S]*?\n\}/.exec(server)?.[0]||'';
  assert.doesNotMatch(stop,/addAdminCenterNotification\('server-clean-shutdown'/);
  assert.match(stop,/clean:true,shutdownAt:now/);
  assert.match(start,/addAdminCenterNotification\('server-restarted'/);
});

test('legacy muted preferences are durably normalized so mandatory Maintenance cannot linger',()=>{
  const server=read('server.js');
  const fn=/function accountMutedNotificationCategories\(accountId\) \{[\s\S]*?\n\}/.exec(server)?.[0]||'';
  assert.match(fn,/const clean = normalizeMutedNotificationCategories\(raw\)/);
  assert.match(fn,/acc\.notifMutedCategories = clean/);
  assert.match(fn,/scheduleFlush\(\)/);
  const mutable=/const NOTIFICATION_MUTABLE_CATEGORIES = \[([^\]]*)\]/.exec(server)?.[1]||'';
  assert.doesNotMatch(mutable,/'maintenance'/);
});

test('legacy Activity/System rows are normalized even after the schema marker already exists',()=>{
  const server=read('server.js');
  const fn=/function notificationCenterStore\(\) \{[\s\S]*?function trimNotificationCenterAccount/.exec(server)?.[0]||'';
  assert.match(fn,/for \(const n of before\) \{[\s\S]*migratedNotificationCategory\(n\)/);
  const marker=fn.indexOf("notificationCategorySchemaVersion || 0");
  const normalize=fn.indexOf('migratedNotificationCategory(n)');
  assert.ok(normalize>=0 && marker>=0 && normalize<marker,'normalization must not depend on advancing the schema marker');
});
