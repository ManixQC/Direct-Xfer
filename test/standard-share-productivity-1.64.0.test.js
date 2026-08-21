'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('standard share density supports comfortable, compact and very compact modes', () => {
  assert.match(app, /\['comfortable','compact','ultra'\]/);
  assert.match(app, /density-ultra/);
  assert.match(app, /const order=\['comfortable','compact','ultra'\]/);
  assert.match(css, /\.shares-list\.density-ultra/);
  assert.match(css, /\.shares-list\.density-ultra \.share-actions[\s\S]*display:none/);
});

test('share cards open a live accessible side details panel without leaving the list', () => {
  assert.match(app, /function ensureShareDetailsDrawer\(\)/);
  assert.match(app, /function openShareDetails\(s,trigger\)/);
  assert.match(app, /function renderShareDetails\(s\)/);
  assert.match(app, /card\.addEventListener\('click',[\s\S]*openShareDetails/);
  assert.match(app, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.match(app, /if \(state\.shareDetailsId\)[\s\S]*renderShareDetails\(current\)/);
  assert.match(css, /\.share-details-drawer/);
});

test('custom labels are colored, directly filterable and have a dedicated toolbar filter', () => {
  assert.match(html, /id="shares-tag"/);
  assert.match(app, /function tagHue\(tag\)/);
  assert.match(app, /styleTagChip\(chip, tg\)/);
  assert.match(app, /state\.shareTag = tg/);
  assert.match(app, /tagF && !\(Array\.isArray\(s\.tags\)/);
  assert.match(css, /--tag-hue/);
  assert.match(css, /\.tag-label/);
});

test('quick actions are configurable per browser and rendered as icon shortcuts', () => {
  for (const action of ['details','copy','open','stats','edit','clone','pause']) {
    assert.match(html, new RegExp(`data-share-quick-action="${action}"`));
  }
  assert.match(app, /shareQuickActions: 'details,copy,stats,edit,clone'/);
  assert.match(app, /function selectedShareQuickActions\(\)/);
  assert.match(app, /function setShareQuickActions\(ids/);
  assert.match(app, /function renderShareQuickActions\(s, card\)/);
  assert.match(app, /const mutable = state\.role !== 'auditor'/);
  assert.match(css, /\.share-quick-action/);
});

test('pinning remains persistent, sortable and available as a dedicated card control', () => {
  assert.match(app, /pin-toggle/);
  assert.match(app, /toggleShareFlag\(s, 'pinned'\)/);
  assert.match(app, /!!b\.pinned - !!a\.pinned/);
  assert.match(server, /pinned: !!s\.pinned/);
  assert.match(server, /typeof body\.pinned === 'boolean'/);
  assert.match(server, /\['pin','unpin','archive','unarchive'\]/);
});

test('rapid duplication creates a fresh token and resets runtime/link-list state', () => {
  assert.match(app, /function cloneShare\(s, button\)/);
  assert.match(app, /\/api\/shares\/' \+ encodeURIComponent\(s\.id\) \+ '\/clone'/);
  assert.match(server, /adminRouter\.post\('\/shares\/:id\/clone'/);
  assert.match(server, /'pstats', 'bytesReceived', 'pinned', 'archived'/);
  assert.match(server, /clone\.downloads = 0/);
  assert.match(server, /do \{ clone\.token = newToken\(\); \} while \(getByToken\(clone\.token\)\)/);
  assert.match(app, /data-quick-action':id/);
});

test('an intentionally empty quick-action toolbar persists across reloads', () => {
  assert.match(app, /state\.shareQuickActions === 'none'/);
  assert.match(app, /normalized\.length \? normalized\.join\(','\) : 'none'/);
  assert.match(app, /shareQuickActions: uiPrefText\('shareQuickActions'\) \|\| 'details,copy,stats,edit,clone'/);
});

test('details drawer traps keyboard focus, locks background scrolling and restores focus after live rerenders', () => {
  assert.match(app, /'aria-modal':'true'/);
  assert.match(app, /if\(e\.key==='Tab'\)/);
  assert.match(app, /focusable=\[\.\.\.drawer\.querySelectorAll/);
  assert.match(app, /const restore=state\.shareDetailsRestoreFocus, shareId=state\.shareDetailsId/);
  assert.match(app, /document\.querySelector\('\[data-share-id=/);
  assert.match(css, /body\.share-details-open \{ overflow:hidden; \}/);
});

test('auditor tag controls are omitted from the DOM rather than only hidden with CSS', () => {
  assert.match(app, /function tagsSection\(s\)[\s\S]*const mutable = state\.role !== 'auditor'/);
  assert.match(app, /if \(mutable\) \{[\s\S]*class: 'tag-x'/);
  assert.match(app, /if \(mutable\) \{[\s\S]*class: 'tag-add'/);
});


test('standard UI audit bumps asset cache keys for corrected resources', () => {
  assert.match(html, /style\.css\?v=315/);
  assert.match(html, /app\.js\?v=346/);
});


test('source-health decoration cannot self-trigger a subtree MutationObserver loop', () => {
  const productivity = fs.readFileSync(path.join(root, 'public', 'standard-productivity.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(productivity, /shareObserver\.observe\(shareList,\{childList:true\}\)/);
  assert.doesNotMatch(productivity, /shareObserver\.observe\([^\n]*subtree\s*:\s*true/);
  assert.match(productivity, /if\(badge\.textContent!==text\)badge\.textContent=text/);
  assert.match(productivity, /backingDecoratePending/);
  assert.match(index, /standard-productivity\.js\?v=4/);
});
