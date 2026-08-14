'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

function loadSizingHelpers() {
  const start = app.indexOf('  function imageVariantLongSide(variant, fallback)');
  const end = app.indexOf('  async function makeImageVariants(file, currentVariants)', start);
  assert.ok(start >= 0 && end > start, 'variant sizing helpers must be present');
  const context = {};
  vm.runInNewContext(app.slice(start, end) + '\nthis.longSide = imageVariantLongSide; this.dimensions = imageVariantDimensions;', context);
  return context;
}

test('the PWA editor passes the current Mini/Micro metadata when regenerating variants', () => {
  const start = app.indexOf('async function commitImageReplacement(photo');
  const end = app.indexOf('async function editUploadedImage(photo)', start);
  assert.ok(start > 0 && end > start);
  const body = app.slice(start, end);
  assert.match(body, /makeImageVariants\(prepared\.blob, photo && photo\.variants\)/);
  assert.doesNotMatch(body, /makeImageVariants\(prepared\.blob\);/);
});

test('custom longest sides are preserved without distorting an edited image', () => {
  const sizing = loadSizingHelpers();
  assert.equal(sizing.longSide({ w: 320, h: 213 }, 480), 320);
  assert.equal(sizing.longSide({ w: 111, h: 167 }, 240), 167);
  assert.deepEqual({ ...sizing.dimensions(1200, 800, 320) }, { width: 320, height: 213 });
  assert.deepEqual({ ...sizing.dimensions(800, 1200, 320) }, { width: 213, height: 320 });
});

test('missing variant metadata keeps the safe defaults and variants are never upscaled', () => {
  const sizing = loadSizingHelpers();
  assert.equal(sizing.longSide(null, 480), 480);
  assert.equal(sizing.longSide({ w: 0, h: null }, 240), 240);
  assert.deepEqual({ ...sizing.dimensions(100, 80, 480) }, { width: 100, height: 80 });
});
