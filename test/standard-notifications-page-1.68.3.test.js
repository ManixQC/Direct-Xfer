const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const httpApplication = fs.readFileSync(path.join(root, 'lib', 'server', 'http-application.js'), 'utf8');

test('standard notification center is an independent full page', () => {
  assert.match(html, /<main id="notifications-page" class="app-view notifications-page hidden">/);
  assert.match(html, /id="notifications-back"/);
  assert.match(html, /id="notifications-list"/);
  assert.doesNotMatch(html, /id="notifications-dropdown"/);
  assert.match(app, /const NOTIFICATIONS_PATH = '\/notifications';/);
  assert.match(app, /function showNotificationsView\(\)/);
  assert.match(app, /function closeNotificationsPage\(\)/);
  assert.match(app, /openNotificationsPage\(\)/);
  assert.match(app, /function syncAdminRouteFromUrl\(\)[\s\S]*location\.pathname === NOTIFICATIONS_PATH[\s\S]*showNotificationsView\(\)/);
  assert.match(app, /function closeActivityPage\(\)[\s\S]*location\.pathname === ACTIVITY_PATH/);
  assert.match(app, /function openNotificationTarget\(n\)[\s\S]*notificationsPageOpen\(\)[\s\S]*dxView:'home'/);
  assert.match(httpApplication, /'\/notifications'/);
  assert.match(httpApplication, /app\.get\(route, adminGuard/);
  assert.match(css, /#notifications-page \.brand/);
  assert.match(css, /\.notifications-page-card/);
  assert.match(css, /\.notification-list \{ display:flex; flex-direction:column/);
});

test('notification page destructive and Escape behavior use the in-app UX', () => {
  assert.match(app, /notifications-clear[\s\S]*?confirmDirectXferAction\(t\('notifications\.clearConfirm'\)/);
  assert.doesNotMatch(app, /notifications-clear'\)\) \$\('notifications-clear'\)\.addEventListener[\s\S]{0,260}?\bconfirm\(/);
  assert.match(app, /invalidateNotificationsFetch\(\);[\s\S]{0,160}?accountNotifications = \[\]/);
  assert.match(app, /userDropdown[\s\S]{0,180}?closeUserMenu\(\); return;[\s\S]{0,220}?notifications-prefs[\s\S]{0,180}?closeNotificationsMenu\(\); return;/);
  assert.match(app, /notifications\.priorityUrgent/);
  assert.match(app, /notifications\.priorityHigh/);
});
