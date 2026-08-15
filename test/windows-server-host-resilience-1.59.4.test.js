'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const host = read('windows-server-host', 'Program.cs');
const readme = read('windows-launcher', 'README-WINDOWS-PORTABLE.md');

test('ServerHost retries an unexpectedly terminated backend with bounded exponential backoff', () => {
  assert.match(host, /var consecutiveFailures = 0;/);
  assert.match(host, /Math\.Min\(consecutiveFailures \+ 1, 6\)/);
  assert.match(host, /Math\.Min\(30000, 1000 \* \(1 << \(consecutiveFailures - 1\)\)\)/);
  assert.match(host, /backend stopped unexpectedly; retrying in/);
  assert.match(host, /WaitHandle\.WaitAny\(new WaitHandle\[\] \{ _stopEvent, _reloadEvent \}, delayMs\)/);
});

test('an unmarked exit code 0 is treated as unexpected instead of silently stopping supervision', () => {
  assert.match(host, /return clean \? 0 : \(code == 0 \? 1 : code\);/);
});

test('portable documentation explains the required independent ServerHost start without reintroducing launcher spawning', () => {
  assert.match(readme, /Démarrage du package portable/);
  assert.match(readme, /lancez `Direct-Xfer\.ServerHost\.exe`/);
  assert.match(readme, /lancez ensuite `Direct-Xfer\.exe`/);
});


test('ServerHost forgets old crash-loop penalties after a stable backend run', () => {
  assert.match(host, /_lastReadyUptimeMs >= 60000/);
  assert.match(host, /_lastReadyUptimeMs = readyWatch\.ElapsedMilliseconds/);
  assert.match(host, /if \(_lastReadyUptimeMs >= 60000\) consecutiveFailures = 0;/);
});
