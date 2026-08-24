'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'lib/server/http-application.js'),'utf8');

test('System Health launcher sits between Dashboards and Activity in the admin topbar',()=>{
  const dash=html.indexOf('id=\"dash-btn\"');
  const health=html.indexOf('id=\"system-health-btn\"');
  const activity=html.indexOf('id=\"activity-btn\"');
  assert.ok(dash>=0&&health>dash&&activity>health);
});

test('all server health cards live only in the dedicated System Health page',()=>{
  const healthPage=html.indexOf('id=\"system-health-page\"');
  const imagesPage=html.indexOf('id=\"images-page\"');
  const healthCard=html.indexOf('id=\"server-health-score\"');
  assert.ok(healthPage>=0&&healthCard>healthPage&&healthCard<imagesPage);
  assert.doesNotMatch(html,/dashboard-health-(?:tab|view)/);
});

test('System Health has independent routing, access gating and polling lifecycle',()=>{
  assert.match(app,/const SYSTEM_HEALTH_PATH = '\/system-health'/);
  assert.match(app,/function showSystemHealthView\(\)/);
  assert.match(app,/DirectXferServerHealth\.start/);
  assert.match(app,/DirectXferServerHealth\.stop/);
  assert.match(app,/!systemHealthPageOpen\(\)/);
  assert.match(server,/'\/system-health'/);
  assert.match(server,/app\.get\(route, adminGuard/);
});

const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
const healthModule=fs.readFileSync(path.join(root,'public/server-health-dashboard.js'),'utf8');

test('System Health counts as an authenticated admin view',()=>{
  const match=app.match(/function isLoggedIn\(\) \{[\s\S]*?\n\}/);
  assert.ok(match,'isLoggedIn function');
  const fn=new Function('$', match[0]+'; return isLoggedIn;')((id)=>({classList:{contains:(name)=>name==='hidden' ? id!=='system-health-page' : false}}));
  assert.equal(fn(),true);
  assert.match(match[0],/'system-health-page'/);
});

test('legacy dashboard health preference is migrated away',()=>{
  assert.doesNotMatch(app,/uiPrefChoice\('dashboardTab', \[[^\]]*'health'/);
  assert.match(app,/dashboardTab: uiPrefChoice\('dashboardTab', \['transfers', 'images'\], 'transfers'\)/);
});

test('expired System Health session returns immediately to login',()=>{
  assert.match(healthModule,/e\.status===401&&typeof window\.showLogin==='function'\)window\.showLogin\(\)/);
  assert.match(healthModule,/else if\(typeof window\.closeSystemHealthPage==='function'\)window\.closeSystemHealthPage\(\)/);
});

test('System Health launcher keeps its dedicated button shape despite user-btn base styles',()=>{
  assert.match(css,/\.user-btn\.system-health-launch-btn \{[\s\S]*?width: auto;[\s\S]*?border-radius: 11px;/);
  assert.match(css,/@media \(max-width: 900px\) \{[\s\S]*?\.user-btn\.system-health-launch-btn \{ min-width: 40px; width: 40px; padding: 0; \}/);
});

test('corrected standard assets use fresh cache busters',()=>{
  assert.match(html,/style\.css\?v=319/);
  assert.match(html,/app\.js\?v=352/);
  assert.match(html,/server-health-dashboard\.js\?v=4/);
});
