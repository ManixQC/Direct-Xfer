'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('available update link targets the Direct-Xfer GitHub repository', () => {
  assert.match(
    server,
    /url:\s*updateState\.available\s*\?\s*['"]https:\/\/github\.com\/ManixQC\/Direct-Xfer['"]\s*:\s*null/,
  );
  assert.doesNotMatch(
    server,
    /url:\s*updateState\.available\s*\?\s*`https:\/\/hub\.docker\.com\/r\/\$\{UPDATE_REPO\}`\s*:\s*null/,
  );
});
