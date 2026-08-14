'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const pwaJs = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'app.js'), 'utf8');

test('admin Shares polling is not frozen by focused checkbox/select controls', () => {
  const start = adminJs.indexOf('const editingInList =');
  assert.ok(start >= 0);
  const block = adminJs.slice(start, start + 700);
  assert.match(block, /a\.tagName === 'TEXTAREA'/);
  assert.match(block, /a\.tagName === 'INPUT'/);
  assert.match(block, /'checkbox'/);
  assert.match(block, /'radio'/);
  assert.doesNotMatch(block, /\^\(INPUT\|TEXTAREA\|SELECT\)\$/);
});

test('admin Images drops selections that become hidden by filters/search', () => {
  const start = adminJs.indexOf('const ordered = visiblePhotos(photos);');
  assert.ok(start >= 0);
  const block = adminJs.slice(start, start + 850);
  assert.match(block, /const visibleIds = new Set\(ordered\.map\(\(s\) => s\.id\)\)/);
  assert.match(block, /state\.photoSelection\.delete\(id\)/);
  assert.match(block, /updatePhotoBulkBar\(\)/);
});

test('admin Images escapes copied HTML attributes and Markdown labels', () => {
  assert.match(adminJs, /function escapePhotoHtmlAttr\(value\)/);
  assert.match(adminJs, /function escapePhotoMarkdownAlt\(value\)/);
  assert.match(adminJs, /const mdName = escapePhotoMarkdownAlt\(name\)/);
  assert.match(adminJs, /const htmlName = escapePhotoHtmlAttr\(name\)/);
});

test('PWA image filters cannot leave hidden images selected for bulk actions', () => {
  const start = pwaJs.indexOf('var visibleTokens = new Set(rows.map');
  assert.ok(start >= 0);
  const block = pwaJs.slice(start, start + 750);
  assert.match(block, /selectedImageTokens\.delete\(token\)/);
  assert.match(block, /hiddenRow\.classList\.remove\('selected'\)/);
  assert.match(block, /hiddenCb\.checked = false/);
});

test('PWA queue filters cannot leave hidden files selected for bulk actions', () => {
  const start = pwaJs.indexOf('var visibleIds = new Set(visible.map');
  assert.ok(start >= 0);
  const block = pwaJs.slice(start, start + 420);
  assert.match(block, /selectedIds\.delete\(id\)/);
});

test('PWA Mini/Micro uploader treats HTTP errors as failures', async () => {
  const start = pwaJs.indexOf('  async function uploadGeneratedImageVariants');
  const end = pwaJs.indexOf('  async function replaceImageKeepingUrl', start);
  assert.ok(start >= 0 && end > start);
  const functionSource = pwaJs.slice(start, end);
  assert.match(functionSource, /result\.value\.ok/);

  async function run(statuses, adaptive = false) {
    const context = {
      encodeURIComponent,
      appMutate: async () => ({ ok: statuses.shift() }),
      result: undefined,
    };
    vm.createContext(context);
    vm.runInContext(functionSource + `\nresult = uploadGeneratedImageVariants('tok', {thumb:{}, micro:{}, adaptiveWebp:${adaptive ? '{}' : 'null'}});`, context);
    return context.result;
  }

  assert.equal(await run([true, true]), true);
  assert.equal(await run([false, true]), false);
  assert.equal(await run([true, false]), false);
  // Adaptive formats are best-effort: Full/Mini/Micro remain valid if WebP fails.
  assert.equal(await run([true, true, false], true), true);
});

test('PWA Markdown copy uses an escaping helper for Reddit and Markdown formats', () => {
  assert.match(pwaJs, /function escapeMarkdownLabel\(value\)/);
  assert.match(pwaJs, /template === 'reddit'[^\n]+escapeMarkdownLabel\(alt\)/);
  assert.match(pwaJs, /fmt === 'md'[^\n]+escapeMarkdownLabel\(alt\)/);
  assert.match(pwaJs, /imgVariantsFailed:/);
});
