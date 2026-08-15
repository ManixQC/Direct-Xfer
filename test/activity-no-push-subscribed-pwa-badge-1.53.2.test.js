const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('push-subscribed stays audited but is excluded from Activity, including persisted history', () => {
  const server = read('server.js');
  assert.match(server, /ACTIVITY_IGNORED_AUDIT_ACTIONS = new Set\(\['push-subscribed'\]\)/);
  assert.match(server, /!activityEventVisible\(event\)/);
  assert.match(server, /!ACTIVITY_IGNORED_AUDIT_ACTIONS\.has\(String\(entry\.action \|\| ''\)\)/);
  // Both standard and PWA subscriptions still produce an audit entry.
  assert.match(server, /auditReq\(req, 'push-subscribed', rec\.ua\)/);
  assert.match(server, /pwaAuditReq\(req, 'push-subscribed'/);
});

test('PWA Activity tab has no count bubble and no activity badge calculation', () => {
  const html = read('pwa', 'index.html');
  const app = read('pwa', 'app.js');
  assert.doesNotMatch(html, /id="nav-activity-badge"/);
  assert.doesNotMatch(app, /\['nav-activity-badge'/);
  assert.doesNotMatch(app, /var historyCount = .*serverActivityRetained/);
  // Activity itself remains available.
  assert.match(html, /data-pwa-nav="activity"/);
  assert.match(app, /activity: \{ label: 'navActivity'/);
});

test('release is 1.54.0 with a fresh PWA cache', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.59.8');
  assert.equal(JSON.parse(read('package-lock.json')).version, '1.59.8');
  assert.match(read('pwa', 'app.js'), /APP_VERSION = '1\.59\.8'/);
  assert.match(read('pwa', 'app.js'), /APP_BUILD = '2026\.08\.14-pwa287'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.14-pwa287'/);
  assert.match(read('pwa', 'index.html'), /app\.js\?v=270/);
  assert.match(read('pwa', 'sw.js'), /app\.js\?v=270/);
});
