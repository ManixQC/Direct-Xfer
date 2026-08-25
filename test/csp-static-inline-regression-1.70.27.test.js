'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('admin HTML uses an external first-paint theme bootstrap allowed by script-src self', () => {
  const html = read('public/index.html');
  const themeInit = read('public/theme-init.js');

  assert.match(html, /<script\s+src="\/theme-init\.js\?v=1\.70\.27"><\/script>/);
  assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*\(function\s*\(\)/i);
  assert.match(themeInit, /localStorage\.getItem\('dx-theme'\)/);
  assert.match(themeInit, /document\.documentElement\.setAttribute\('data-theme', t\)/);
  const windowsHost = read('windows-server-host/Program.cs');
  assert.match(windowsHost, /\{ \"public\/theme-init\.js\", \"[0-9a-f]{64}\" \}/);
});

test('static public and PWA HTML contain no executable inline script blocks', () => {
  const roots = ['public', 'pwa'];
  const offenders = [];

  for (const dir of roots) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!name.endsWith('.html')) continue;
      const relative = path.join(dir, name);
      const html = read(relative);
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = re.exec(html))) {
        const attrs = match[1] || '';
        const body = match[2] || '';
        if (/\bsrc\s*=/.test(attrs)) continue;
        // Empty/non-executable script elements are harmless; flag executable body only.
        if (body.trim()) offenders.push(relative);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
