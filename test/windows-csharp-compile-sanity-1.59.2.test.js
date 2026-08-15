'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');

test('1.59.4 initial-password dialog uses legal C# var declarations', () => {
  assert.match(launcher, /var username = GetString\(payload, "username"\);\s*var password = GetString\(payload, "password"\);/);
  assert.doesNotMatch(launcher, /var\s+username\s*=.*?,\s*password\s*=/);
});

test('LauncherSession uses JSON-deserializable properties instead of reflection-only fields', () => {
  for (const member of ['hostPid', 'hostStartedUtcTicks', 'hostPath', 'serverPid', 'port', 'scheme', 'token', 'runtimeBuild']) {
    assert.match(launcher, new RegExp(`public\\s+(?:int|long|string)\\s+${member}\\s*\\{\\s*get;\\s*set;\\s*\\}`));
  }
});
