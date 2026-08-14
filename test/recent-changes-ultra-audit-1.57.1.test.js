'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Windows portable firewall validation checks the effective rule, not only its name', () => {
  assert.match(server, /Get-NetFirewallRule -DisplayName \$n/);
  assert.match(server, /Get-NetFirewallPortFilter/);
  assert.match(server, /Get-NetFirewallAddressFilter/);
  assert.match(server, /Enabled -eq 'True'/);
  assert.match(server, /Direction -eq 'Inbound'/);
  assert.match(server, /Action -eq 'Allow'/);
  assert.match(server, /Protocol -eq 'TCP'/);
  assert.match(server, /RemoteAddress\) -contains 'LocalSubnet'/);
});

test('an invalid stale Direct-Xfer firewall rule is replaced with the exact LAN-only rule', () => {
  assert.match(server, /Remove-NetFirewallRule/);
  assert.match(server, /New-NetFirewallRule -DisplayName \$n -Direction Inbound -Action Allow -Protocol TCP/);
  assert.match(server, /-Profile Any -RemoteAddress LocalSubnet/);
  assert.match(server, /Buffer\.from\(elevatedPs, 'utf16le'\)\.toString\('base64'\)/);
});
