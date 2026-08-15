'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');

test('1.59.4 launcher keeps legal C# var declarations', () => {
  assert.match(launcher, /var username = GetString\(payload, "username"\);\s*var password = GetString\(payload, "password"\);/);
  assert.doesNotMatch(launcher, /var\s+username\s*=.*?,\s*password\s*=/);
});

test('LauncherSession includes host build metadata required for process-free attachment', () => {
  for (const member of ['hostPid', 'hostStartedUtcTicks', 'hostPath', 'serverPid', 'port', 'scheme', 'token', 'runtimeBuild', 'hostBuild']) {
    assert.match(launcher, new RegExp(`public\\s+(?:int|long|string)\\s+${member}\\s*\\{\\s*get;\\s*set;\\s*\\}`));
  }
});

test('ServerHost reload IPC is disposed and does not use unsupported language features', () => {
  assert.match(host, /private readonly EventWaitHandle _reloadEvent/);
  assert.match(host, /_reloadEvent\.Dispose\(\)/);
  assert.doesNotMatch(host, /\basync\s+Main\b|\brecord\b|\busing\s+var\b/);
});
