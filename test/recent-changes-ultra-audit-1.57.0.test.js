'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pub = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'pwa/app.js'), 'utf8');

function literalAuditActions() {
  const set = new Set();
  for (const re of [/auditReq\(req,\s*['"]([^'"]+)['"]/g, /logAudit\(\s*['"]([^'"]+)['"]/g]) {
    let m; while ((m = re.exec(server))) set.add(m[1]);
  }
  // Actions composed dynamically in server.js.
  ['notification-rule-created','notification-rule-updated','notification-rule-reused',
   'storage-connector-upload','storage-connector-download','storage-connector-done','storage-connector-failed']
    .forEach((x) => set.add(x));
  return [...set].sort();
}

function pwaTranslatedKeys() {
  const out = new Set();
  for (const name of ['PWA_ACTIVITY_ACTIONS','PWA_ACTIVITY_ACTIONS_EXTRA']) {
    const marker = `var ${name} = `;
    const start = pwa.indexOf(marker);
    assert.notEqual(start, -1, `${name} missing`);
    const tail = pwa.slice(start, pwa.indexOf('\n  function', start));
    for (const m of tail.matchAll(/["']([a-z0-9-]+)["']\s*:/g)) out.add(m[1]);
  }
  return out;
}

function standardTranslated(action) {
  const i18n = new RegExp(`["']auditA\\.${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`, 'g');
  const count = [...pub.matchAll(i18n)].length;
  if (count === 3) return true;
  for (const name of ['AUDIT_ACTION_LABELS','AUDIT_ACTION_LABELS_EXTRA']) {
    const marker = `const ${name} = `;
    const start = pub.indexOf(marker);
    if (start < 0) continue;
    const end = pub.indexOf('\nfunction', start);
    const tail = pub.slice(start, end > start ? end : start + 30000);
    if (new RegExp(`["']${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`).test(tail)) return true;
  }
  return false;
}

test('every audit action emitted by the server has a standard and PWA translation path', () => {
  const actions = literalAuditActions();
  const pwaKeys = pwaTranslatedKeys();
  assert.deepEqual(actions.filter((a) => !standardTranslated(a)), []);
  assert.deepEqual(actions.filter((a) => !pwaKeys.has(a)), []);
});

test('recent Activity machine statuses and structured details are localized', () => {
  for (const value of ['queued','pending','paused-all','resumed-all']) {
    assert.match(pub, new RegExp(`"${value}"\\s*:`));
    assert.match(pwa, new RegExp(`"${value}"\\s*:`));
  }
  assert.match(pub, /sent=\(\\d\+\)/);
  assert.match(pub, /transferredShares/);
  assert.match(pwa, /transferredShares/);
});

test('PWA Activity filters use the same robust PWA/image classification rules as standard Activity', () => {
  assert.match(pub, /function activityIsPwa\(e\)/);
  assert.match(pub, /function activityIsImage\(e\)/);
  assert.match(pwa, /function pwaServerActivityIsPwa\(e\)/);
  assert.match(pwa, /function pwaServerActivityIsImage\(e\)/);
  assert.match(pwa, /!imagesOnly \|\| pwaServerActivityIsImage\(e\)/);
  assert.match(pwa, /!pwaOnly \|\| pwaServerActivityIsPwa\(e\)/);
});

test('PWA Shift+click works from the file row/label, not only the tiny checkbox', () => {
  assert.match(pwa, /lab\.addEventListener\('click',[\s\S]{0,260}ev\.shiftKey/);
  assert.match(pwa, /ev\.preventDefault\(\)/);
});

test('Windows portable LAN rule stays local-subnet scoped and is launcher-only', () => {
  assert.match(server, /DX_WINDOWS_LAUNCHER_TOKEN/);
  assert.match(server, /-RemoteAddress LocalSubnet/);
  assert.match(server, /-Profile Any/);
  assert.match(server, /if \(process\.platform !== 'win32' \|\| !DX_WINDOWS_LAUNCHER_TOKEN\) return/);
});
