'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const html = read('public/index.html');
const css = read('public/style.css');
const app = read('public/app.js');

test('1.67.26 standard + menu uses one fixed icon column for every create-link action', () => {
  const ids = [
    'new-collab-btn', 'new-inbox-btn', 'new-secret-btn', 'new-enc-btn',
    'new-web-storage-btn', 'new-web-inbox-btn', 'new-web-collab-btn'
  ];
  for (const id of ids) {
    const re = new RegExp(`id="${id}"[^>]*class="[^"]*share-create-menu-item[^"]*"[^>]*>\\s*<span class="share-create-menu-icon"`);
    assert.match(html, re, `${id} must use the aligned create-menu row structure`);
  }
  assert.match(css, /\.share-action-menu-panel \.share-create-menu-item\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*2\.35rem minmax\(0, 1fr\)/s);
  assert.match(css, /\.share-create-menu-icon\s*\{[^}]*justify-content:\s*center[^}]*width:\s*2\.35rem/s);
  assert.match(css, /\.share-create-menu-label\s*\{[^}]*text-align:\s*left/s);
});

test('1.67.26 create-menu translations no longer embed icon glyphs that would duplicate the fixed icon column', () => {
  for (const key of ['sh.newCollab','sh.newInbox','secret.new','enc.newShare','webStorage.new','webStorage.newInbox','webStorage.newCollab']) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...app.matchAll(new RegExp(`'${escaped}':\\s*'([^']+)'`, 'g'))];
    assert.ok(matches.length >= 3, `${key} should exist in all standard UI languages`);
    for (const match of matches) assert.doesNotMatch(match[1], /[☁＋🔁🔑🔒]/, `${key} label should contain text only`);
  }
});
