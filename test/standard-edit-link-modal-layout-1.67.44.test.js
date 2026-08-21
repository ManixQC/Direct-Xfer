'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('public/index.html');
const css = read('public/style.css');
const app = read('public/app.js');
const editBlock = html.slice(
  html.indexOf('<!-- ===================== Edit link (modal) ===================== -->'),
  html.indexOf('<!-- ===================== Video preview (modal) ===================== -->')
);

test('1.69.3 edit-link modal has a dedicated scroll body with pinned header/actions', () => {
  assert.match(editBlock, /class="modal modal-edit"/);
  assert.match(editBlock, /id="edit-modal-body" class="edit-modal-body"/);
  assert.ok(editBlock.indexOf('id="edit-modal-body"') < editBlock.indexOf('id="edit-error"'));
  assert.ok(editBlock.indexOf('id="edit-error"') < editBlock.indexOf('class="modal-foot"'));
  assert.match(css, /\.modal-edit\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*24px\)[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.edit-modal-body\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.modal-edit\s*>\s*\.modal-foot\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
});

test('1.69.3 edit-link options are grouped instead of one unstructured flex row', () => {
  for (const id of [
    'edit-section-general', 'edit-section-limits', 'edit-section-security',
    'edit-section-behavior', 'edit-section-reception', 'edit-section-appearance'
  ]) assert.match(editBlock, new RegExp(`id="${id}"`));
  assert.match(css, /\.edit-grid-3\s*\{\s*grid-template-columns:\s*repeat\(3,/);
  assert.match(css, /@media \(max-width:\s*620px\)[\s\S]*?\.edit-grid-2,[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /#edit-overlay\s*\{\s*padding:\s*12px/);
});

test('1.69.3 keeps every edit control exactly once after reorganizing the modal', () => {
  const ids = [
    'edit-name','edit-expiry','edit-expireat','edit-startsat','edit-maxdl','edit-maxvisitors',
    'edit-dlthreshold','edit-maxdlperip','edit-maxbytesserved','edit-emoji','edit-password','edit-pwhint',
    'edit-clearpw','edit-rate','edit-allowzip','edit-preview','edit-burn','edit-requestaccess','edit-feedback',
    'edit-rx-maxfiles','edit-rx-maxfilesupload','edit-rx-maxfilemb','edit-rx-maxtotalmb','edit-rx-maxfilessender',
    'edit-rx-maxmbsender','edit-rx-allowext','edit-rx-blockext','edit-rx-groupsender','edit-rx-tagsender',
    'edit-rx-rejectdup','edit-rx-requiresender','edit-rx-blockexec','edit-rx-moderated','edit-rx-allowdelete',
    'edit-geomode','edit-geocountries','edit-ipmode','edit-iplist','edit-color','edit-tags','edit-reminder',
    'edit-firstuse','edit-inactive','edit-description','edit-note'
  ];
  for (const id of ids) {
    const matches = editBlock.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(matches.length, 1, `${id} should occur once in edit modal`);
  }
});

test('1.69.3 access-rule translations no longer collide with Admin accounts', () => {
  assert.doesNotMatch(html, /data-i18n="acc\.title">Access rules/);
  assert.match(html, /data-i18n="access\.title">Access rules/);
  assert.match(html, /data-i18n="acc\.title">Admin accounts/);
  assert.match(app, /'access\.title':\s*'Règles d’accès \(géo \/ IP\)'/);
  assert.match(app, /'acc\.title':\s*'Comptes admin'/);
});

test('1.69.3 reopening the edit dialog starts at the top of its internal scroller', () => {
  assert.match(app, /const editBody = \$\('edit-modal-body'\);\s*if \(editBody\) editBody\.scrollTop = 0;/);
});
