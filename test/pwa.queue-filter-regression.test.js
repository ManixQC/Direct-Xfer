'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pwa = fs.readFileSync(path.resolve(__dirname, '..', 'pwa', 'app.js'), 'utf8');

test('an active queue filter keeps its search control visible below four items', () => {
  assert.match(
    pwa,
    /queue-search-wrap'\)\.classList\.toggle\('hidden',\s*totalVisible\s*<\s*4\s*&&\s*!queueFilter\)/,
    'otherwise a live filter can hide every remaining file while its clear control is inaccessible'
  );
});

test('queue preview creates only one preview button per file row', () => {
  const renderStart = pwa.indexOf('function renderQueue()');
  const renderEnd = pwa.indexOf('function selectedItems()', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const render = pwa.slice(renderStart, renderEnd);
  const allocations = render.match(/var pv = document\.createElement\('button'\)/g) || [];
  assert.equal(allocations.length, 1, 'preview button allocation was duplicated');
});
