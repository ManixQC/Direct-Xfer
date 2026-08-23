'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The /api/meta handler (which builds the update link) lives in the extracted
// entry-point route module; server.js only registers the route.
const rootRoutes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'root-routes.js'), 'utf8');

test('available update link targets the Direct-Xfer GitHub repository', () => {
  assert.match(
    rootRoutes,
    /url:\s*updateState\.available\s*\?\s*['"]https:\/\/github\.com\/ManixQC\/Direct-Xfer['"]\s*:\s*null/,
  );
  assert.doesNotMatch(
    rootRoutes,
    /url:\s*updateState\.available\s*\?\s*`https:\/\/hub\.docker\.com\/r\/\$\{UPDATE_REPO\}`\s*:\s*null/,
  );
});
