'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('Windows C# launcher embeds and uses the round Direct-Xfer icon', () => {
  const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
  const project = fs.readFileSync(path.join(root, 'windows-launcher', 'DirectXfer.Launcher.csproj'), 'utf8');
  const ico = path.join(root, 'windows-launcher', 'direct-xfer.ico');
  assert.equal(fs.existsSync(path.join(root, 'windows-launcher', 'rsrc_windows_amd64.syso')), false);
  assert.equal(fs.existsSync(ico), true);
  assert.ok(fs.statSync(ico).size > 1000);
  assert.match(project, /<ApplicationIcon>direct-xfer\.ico<\/ApplicationIcon>/);
  assert.match(launcher, /Icon\.ExtractAssociatedIcon\(Assembly\.GetExecutingAssembly\(\)\.Location\)/);
  assert.match(launcher, /Icon = LoadApplicationIcon\(\)/);
});
