'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Windows ServerHost recovers only the exact private Node process recorded in its saved session', () => {
  assert.match(host, /RecoverSavedSession\(\)/);
  assert.match(host, /ReadSession\(\)/);
  assert.match(host, /TryReady\(session\.port, session\.token, session\.scheme, session\.serverPid/);
  assert.match(host, /Process\.GetProcessById\(session\.serverPid\)/);
  assert.match(host, /process\.MainModule/);
  assert.match(host, /session\.nodePath/);
  assert.match(host, /Path\.GetFullPath\(session\.nodePath\)/);
  assert.match(host, /sameExecutable && sameStart/);
  assert.match(host, /process\.Kill\(\)/);
  assert.match(host, /WriteSessionAtomic\(new HostSession/);
  assert.match(host, /ClearSession\(/);
  assert.doesNotMatch(launcher, /GetExtendedTcpTable|QueryFullProcessImageNameW|OpenProcess|process\.Kill\(\)/);
});

test('server tracks and forcibly resets accepted sockets during bounded shutdown', () => {
  assert.match(server, /const activeHttpSockets = new Set\(\)/);
  assert.match(server, /server\.on\('connection'/);
  assert.match(server, /function resetActiveHttpSocketsForShutdown\(\)/);
  assert.match(server, /socket\.resetAndDestroy\(\)/);
  assert.match(server, /resetActiveHttpSocketsForShutdown\(\)[\s\S]*server\.closeAllConnections/);
});
