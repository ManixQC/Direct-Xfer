'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExternalCryptoProvider } = require('../lib/server/external-crypto-provider');
const { writeFakeProvider } = require('./helpers/asvs-l3-fixture');

const ROOT = path.resolve(__dirname, '..');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-17028-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}

test('1.71.33 launches JavaScript crypto providers through Node for Windows execFile compatibility', (t) => {
  const providerFile = writeFakeProvider(temp(t));
  const calls = [];
  const provider = createExternalCryptoProvider({
    command: providerFile,
    execFileSync(executable, args, options) {
      calls.push({ executable, args:[...args] });
      return childProcess.execFileSync(executable, args, options);
    },
  });
  assert.ok(provider);
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, [providerFile]);
});

test('1.71.33 static regex inventory avoids the CodeQL exponential-backtracking pattern', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'asvs-static-audit.js'), 'utf8');
  const vulnerable = String.raw`\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*`;
  assert.equal(source.includes(vulnerable), false);
  assert.equal(source.includes(String.raw`const matches = line.match(/\/(?:\\.|[^/\n\\])+\/[dgimsuvy]*/g);`), true);
});
