'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
function normalizedSha(rel) {
  const txt = read(rel).replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  return crypto.createHash('sha256').update(txt).digest('hex');
}
test('complete project infrastructure is present', () => {
  for (const rel of [
    '.github/workflows/build-windows-csharp.yml','installer/Direct-Xfer.iss','README.md',
    'unraid/direct-xfer.xml','unraid/direct-xfer.png',
    'windows-launcher/DirectXfer.Launcher.csproj','windows-launcher/Program.cs','windows-launcher/direct-xfer.ico',
    'windows-server-host/DirectXfer.ServerHost.csproj','windows-server-host/Program.cs','windows-server-host/direct-xfer.ico'
  ]) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
});
test('source tree does not keep a redundant prebuilt Windows runtime', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'runtime')), false);
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /runtime\\app/);
  assert.match(workflow, /runtime\\node/);
  assert.ok(workflow.includes("Copy-Item @('package.json','package-lock.json','server.js') $app"));
  assert.ok(workflow.includes("Copy-Item @('lib','public','pwa','scripts','security') $app -Recurse"));
  assert.match(workflow, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
});
test('Windows metadata targets 1.67.1 and current runtime hashes', () => {
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  assert.match(launcher, /AppVersion = "1\.67\.1"/);
  assert.match(launcher, /RuntimeAppBuild = "1\.67\.1-launcher87-csharp"/);
  assert.match(host, /RuntimeAppBuild = "1\.67\.1-launcher87-csharp"/);
  assert.match(host, /HostVersion = "1\.67\.1-serverhost60-csharp"/);
  for (const rel of ['package.json','package-lock.json','server.js','lib/server/public-pages.js','lib/server/tls-manager.js','lib/server/network-services.js','lib/server/notification-service.js','lib/server/backup-service.js','public/app.js','pwa/app.js']) {
    assert.ok(host.includes(normalizedSha(rel)), rel + ' hash');
  }
});
test('forbidden generated project files are absent', () => {
  const forbidden = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(AUDIT|README-PATCH|UNSIGNED-WINDOWS-)/i.test(entry.name) || entry.name === 'reconstruire_git_local_propre_v2.ps1') forbidden.push(path.relative(ROOT, full));
    }
  }
  walk(ROOT);
  assert.deepEqual(forbidden, []);
});

test('Windows GitHub Actions run name follows Direct-Xfer 1.67.1', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /^run-name: v1\.67\.1$/m);
});
