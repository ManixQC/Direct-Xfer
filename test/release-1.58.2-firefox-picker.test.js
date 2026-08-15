'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const css = read('public', 'style.css');
const app = read('public', 'app.js');

test('1.59.8 picker uses one bounded dialog body scroller that is Firefox-safe', () => {
  assert.match(css, /Create-share picker layout \(1\.58\.3\)/);
  assert.match(css, /#picker-overlay\s*\{[\s\S]*overflow:\s*hidden[\s\S]*overscroll-behavior:\s*none/);
  assert.match(css, /\.picker-modal\s*\{[\s\S]*height:\s*var\(--dx-picker-modal-height[\s\S]*overflow:\s*hidden[\s\S]*display:\s*grid/);
  assert.match(css, /\.picker-body\s*\{[\s\S]*min-height:\s*0[\s\S]*overflow-y:\s*auto[\s\S]*scrollbar-width:\s*auto/);
});

test('1.59.8 picker file list no longer collapses to roughly three rows', () => {
  assert.match(css, /\.picker-modal \.browser-list\s*\{[\s\S]*height:\s*var\(--dx-picker-browser-height/);
  assert.doesNotMatch(css, /\.picker-modal \.browser-list\s*\{[^}]*min-height:\s*170px/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*\.picker-modal \.browser-list,[\s\S]*min-height:\s*280px/);
});

test('1.59.8 computes real pixel heights and explicitly chains Firefox wheel scrolling', () => {
  assert.match(app, /function pickerViewportHeight\(\)[\s\S]*Math\.min\(\.\.\.values\)/);
  assert.match(app, /--dx-picker-modal-height/);
  assert.match(app, /--dx-picker-browser-height/);
  assert.match(app, /browserFloor = rawHeight <= 480 \? 220 : \(rawHeight <= 700 \? 280 : tenRowHeight\)/);
  assert.match(app, /installPickerWheelHandoff/);
  assert.match(app, /list\.addEventListener\('wheel'[\s\S]*passive: false/);
  assert.match(app, /body\.scrollTop \+= ev\.deltaY/);
});
