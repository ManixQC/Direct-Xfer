'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
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
<<<<<<< HEAD
test('Windows metadata keeps app 1.71.3 separate from stable Windows component identities', () => {
=======
test('Windows metadata keeps app 1.71.4 separate from stable Windows component identities', () => {
>>>>>>> eb50626 (v1.71.4)
  const launcher = read('windows-launcher/Program.cs');
  const host = read('windows-server-host/Program.cs');
  const hostProject = read('windows-server-host/DirectXfer.ServerHost.csproj');
  const manifestSync = read('scripts/sync-windows-runtime-manifest.js');
  assert.match(launcher, /LauncherVersion = "1\.70\.1"/);
  assert.match(launcher, /LauncherBuild = "launcher149-csharp"/);
  assert.match(launcher, /RuntimeProtocol = "1"/);
  assert.match(launcher, /ServerHostProtocol = "1"/);
  assert.match(host, /ServerHostBuild = "serverhost142-csharp"/);
  assert.match(host, /RuntimeProtocol = "1"/);
  assert.match(host, /ServerHostProtocol = "1"/);
  assert.doesNotMatch(launcher, /RuntimeAppBuild\s*=/);
  assert.doesNotMatch(host, /RuntimeAppBuild\s*=/);

  const manifestPaths = new Set([...host.matchAll(/\{ "([^"]+)", "[0-9a-f]{64}" \}/g)].map((m) => m[1]));
  for (const rel of ['package.json','package-lock.json','server.js','lib/server/config.js','lib/server/platform-dependencies.js','lib/server/bootstrap.js','lib/server/lifecycle-service.js','lib/server/application-context.js','lib/server/bootstrap-reference-registry.js','lib/server/register-application-domains.js','lib/server/application-publication.js','lib/server/state-replacement-coordinator.js','lib/server/state-lifecycle-application.js','lib/server/core-state-application.js','lib/server/notification-application.js','lib/server/security-auth-application.js','lib/server/share-media-transfer-application.js','lib/server/public-http-application.js','lib/server/runtime-services-application.js','lib/server/admin-application.js','lib/server/host-path-service.js','lib/server/request-utils.js','lib/server/windows-launcher-routes.js','lib/server/root-routes.js','lib/server/http-application.js','lib/server/http-pwa-lifecycle-application.js','lib/server/final-http-application.js','lib/server/share-presentation-service.js','lib/auth-utils.js','lib/server/account-service.js','lib/server/auth-service.js','lib/server/session-service.js','lib/server/settings-service.js','lib/server/system-health-service.js','lib/server/diagnostics-service.js','lib/server/admin-router.js','lib/server/admin-account-routes.js','lib/server/admin-security-routes.js','lib/server/admin-storage-routes.js','lib/server/admin-share-routes.js','lib/server/admin-photo-routes.js','lib/server/admin-settings-routes.js','lib/server/admin-dashboard-routes.js','lib/server/admin-diagnostics-routes.js','lib/server/pwa-routes.js','lib/server/pwa-application.js','lib/server/pwa-device-service.js','lib/server/pwa-photo-service.js','lib/server/webauthn-service.js','lib/server/pwa-event-service.js','lib/server/upload-reception-service.js','lib/server/transfer-service.js','lib/server/download-service.js','lib/server/ocr-service.js','lib/server/search-service.js','lib/server/dlp-service.js','lib/server/photo-service.js','lib/server/share-service.js','lib/server/audit-service.js','lib/server/reception-collaboration-routes.js','lib/server/public-access-service.js','lib/server/public-abuse-service.js','lib/server/state-store.js','lib/server/state-bootstrap-service.js','lib/server/public-pages.js','lib/server/tls-manager.js','lib/server/network-services.js','lib/server/windows-install-preferences.js','lib/server/notification-service.js','lib/server/notification-center-service.js','lib/server/pwa-notification-service.js','lib/server/backup-service.js','lib/server/restore-service.js','lib/server/maintenance-service.js','lib/server/storage-connector-job-service.js','lib/server/storage-connector-config.js','public/app.js','pwa/app.js']) {
    assert.ok(manifestPaths.has(rel), rel + ' manifest entry');
  }
  assert.match(hostProject, /SynchronizeRuntimeIntegrityManifest/);
  assert.match(hostProject, /sync-windows-runtime-manifest\.js/);
  assert.match(hostProject, /--write/);
  assert.match(manifestSync, /createHash\('sha256'\)/);
  assert.match(manifestSync, /replace\(\/\\r\\n\?\/g, '\\n'\)/);
});
test('forbidden generated project files are absent', () => {
  const forbidden = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if ((/^(AUDIT|README-PATCH|UNSIGNED-WINDOWS-)/i.test(entry.name) && !/\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry.name)) || entry.name === 'reconstruire_git_local_propre_v2.ps1') forbidden.push(path.relative(ROOT, full));
    }
  }
  walk(ROOT);
  assert.deepEqual(forbidden, []);
});

<<<<<<< HEAD
test('Windows GitHub Actions run name follows Direct-Xfer 1.71.3', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /^run-name: v1\.71\.3$/m);
=======
test('Windows GitHub Actions run name follows Direct-Xfer 1.71.4', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /^run-name: v1\.71\.4$/m);
>>>>>>> eb50626 (v1.71.4)
});
