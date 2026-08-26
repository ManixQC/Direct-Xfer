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

  assert.match(html, /<script\s+src="\/theme-init\.js\?v=1\.71\.11"><\/script>/);
  assert.equal(html.includes('(function () {'), false);
  assert.match(themeInit, /localStorage\.getItem\('dx-theme'\)/);
  assert.match(themeInit, /document\.documentElement\.setAttribute\('data-theme', t\)/);
  const windowsHost = read('windows-server-host/Program.cs');
  assert.match(windowsHost, /\{ \"public\/theme-init\.js\", \"[0-9a-f]{64}\" \}/);
});

function isHtmlSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f';
}

function hasAttribute(attrs, wanted) {
  let i = 0;
  const target = String(wanted || '').toLowerCase();
  while (i < attrs.length) {
    while (i < attrs.length && isHtmlSpace(attrs[i])) i += 1;
    if (i >= attrs.length) break;
    if (attrs[i] === '/') { i += 1; continue; }
    const start = i;
    while (i < attrs.length && !isHtmlSpace(attrs[i]) && attrs[i] !== '=') i += 1;
    const name = attrs.slice(start, i).toLowerCase();
    while (i < attrs.length && isHtmlSpace(attrs[i])) i += 1;
    if (name === target) return true;
    if (attrs[i] !== '=') continue;
    i += 1;
    while (i < attrs.length && isHtmlSpace(attrs[i])) i += 1;
    const quote = attrs[i] === '"' || attrs[i] === "'" ? attrs[i++] : '';
    if (quote) {
      while (i < attrs.length && attrs[i] !== quote) i += 1;
      if (i < attrs.length) i += 1;
    } else {
      while (i < attrs.length && !isHtmlSpace(attrs[i])) i += 1;
    }
  }
  return false;
}

function executableInlineScriptCount(html) {
  const source = String(html || '');
  const lower = source.toLowerCase();
  let cursor = 0;
  let count = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf('<script', cursor);
    if (start < 0) break;
    const boundary = lower[start + 7] || '';
    if (boundary && boundary !== '>' && !isHtmlSpace(boundary)) {
      cursor = start + 7;
      continue;
    }
    const openEnd = lower.indexOf('>', start + 7);
    if (openEnd < 0) break;
    const attrs = source.slice(start + 7, openEnd);
    const closeStart = lower.indexOf('</script', openEnd + 1);
    if (closeStart < 0) break;
    const closeBoundary = lower[closeStart + 8] || '';
    if (closeBoundary && closeBoundary !== '>' && !isHtmlSpace(closeBoundary)) {
      cursor = closeStart + 8;
      continue;
    }
    const closeEnd = lower.indexOf('>', closeStart + 8);
    if (closeEnd < 0) break;
    const body = source.slice(openEnd + 1, closeStart);
    if (!hasAttribute(attrs, 'src') && body.trim()) count += 1;
    cursor = closeEnd + 1;
  }
  return count;
}

test('static public and PWA HTML contain no executable inline script blocks', () => {
  const roots = ['public', 'pwa'];
  const offenders = [];

  for (const dir of roots) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!name.endsWith('.html')) continue;
      const relative = path.join(dir, name);
      if (executableInlineScriptCount(read(relative)) > 0) offenders.push(relative);
    }
  }

  assert.equal(executableInlineScriptCount('<script>run()</script >'), 1);
  assert.equal(executableInlineScriptCount('<script src = "/ok.js"></script >'), 0);
  assert.deepEqual(offenders, []);
});
