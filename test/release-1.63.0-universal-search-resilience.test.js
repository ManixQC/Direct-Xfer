'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('universal metadata search never serializes legacy dates with raw toISOString', () => {
  assert.match(server, /function globalSearchIso\(value\)/);
  assert.match(server, /Number\.isFinite\(d\.getTime\(\)\) \? d\.toISOString\(\) : ''/);
  assert.match(server, /globalSearchIso\(acc\.lastLoginAt\)/);
  assert.match(server, /globalSearchIso\(acc\.createdAt\)/);
  assert.match(server, /globalSearchIso\(h\.at\)/);
  assert.match(server, /globalSearchIso\(e\.at\)/);
});

test('content and metadata result families are isolated so one source cannot fail the whole query', () => {
  assert.match(server, /warnings\.push\('content-index'\)/);
  assert.match(server, /warnings\.push\('metadata'\)/);
  assert.match(server, /degraded:warnings\.length > 0, warnings/);
  assert.match(server, /console\.error\('\[search\] content query failed:'/);
  assert.match(server, /console\.error\('\[search\] metadata query failed:'/);
});
