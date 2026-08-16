'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('initial Windows admin password is selectable and explicitly copyable in the C# launcher', () => {
  assert.match(launcher, /RuntimeAppBuild = "1\.63\.4-launcher52-csharp"/);
  assert.match(launcher, /class InitialPasswordForm : Form/);
  assert.match(launcher, /ReadOnly = true/);
  assert.match(launcher, /InitialPasswordCopy = "Copier le mot de passe"/);
  assert.match(launcher, /passwordBox\.SelectAll\(\)/);
  assert.match(launcher, /Clipboard\.SetText\(password\)/);
  assert.match(launcher, /Shown \+=/);
  assert.match(launcher, /__dx_launcher\/initial-admin-password/);
});

test('main transfer history relative time exposes the exact local timestamp on hover', () => {
  assert.match(app, /title: formatExactDate\(hx\.endedAt\)/);
  assert.match(app, /function formatExactDate\(/);
  assert.match(app, /timeStyle:\s*'medium'/);
});
