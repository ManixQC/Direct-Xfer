'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Windows launcher recovers only the exact private Node process recorded in its saved session', () => {
  assert.match(launcher, /RecoverSavedSession\(\)/);
  assert.match(launcher, /ReadSession\(\)/);
  assert.match(launcher, /TryReady\(session\.port, session\.token, session\.scheme, session\.pid/);
  assert.match(launcher, /Process\.GetProcessById\(session\.pid\)/);
  assert.match(launcher, /process\.MainModule/);
  assert.match(launcher, /session\.nodePath/);
  assert.match(launcher, /Path\.GetFullPath\(session\.nodePath\)/);
  assert.match(launcher, /process\.Kill\(\)/);
  assert.match(launcher, /WriteSession\(new LauncherSession/);
  assert.match(launcher, /ClearSession\(/);
  assert.doesNotMatch(launcher, /GetExtendedTcpTable|QueryFullProcessImageNameW|OpenProcess/);
});

test('server tracks and forcibly resets accepted sockets during bounded shutdown', () => {
  assert.match(server, /const activeHttpSockets = new Set\(\)/);
  assert.match(server, /server\.on\('connection'/);
  assert.match(server, /function resetActiveHttpSocketsForShutdown\(\)/);
  assert.match(server, /socket\.resetAndDestroy\(\)/);
  assert.match(server, /resetActiveHttpSocketsForShutdown\(\)[\s\S]*server\.closeAllConnections/);
});
