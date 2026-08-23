'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');
const server = read('server.js');
const stateBootstrap = read('lib/server/state-bootstrap-service.js');
const coreState = read('lib/server/core-state-application.js');
const searchService = read('lib/server/search-service.js');
const ocrService = read('lib/server/ocr-service.js');

test('1.69.6 launcher defers optional-component housekeeping until backend startup completes', () => {
  const ctor = launcher.match(/internal LauncherContext\(string\[\] args\)[\s\S]*?private Texts Tr/);
  assert.ok(ctor);
  assert.doesNotMatch(ctor[0], /CleanupStaleOptionalWorkDirectories\(\);/);
  assert.doesNotMatch(ctor[0], /MigrateLegacyOptionalActivationState\(\)/);
  assert.match(launcher, /CompleteStartup\(\)[\s\S]{0,900}?OpenRuntimeUrl\(\);[\s\S]{0,240}?ScheduleDeferredMaintenance\(\);/);
  const complete = launcher.match(/private void CompleteStartup\(\)[\s\S]*?private void ScheduleDeferredMaintenance/);
  assert.ok(complete);
  assert.doesNotMatch(complete[0], /OpenBrowser\(\);/);
  assert.match(launcher, /Task\.Delay\(1500, _lifetime\.Token\)/);
});

test('1.69.6 ServerHost validates app runtime and Node concurrently', () => {
  assert.match(host, /var appValidation = Task\.Run\(EnsureApplicationRuntime\);/);
  assert.match(host, /var nodeValidation = Task\.Run\(EnsureNode\);/);
  assert.match(host, /var appDir = appValidation\.GetAwaiter\(\)\.GetResult\(\);[\s\S]{0,160}?var node = nodeValidation\.GetAwaiter\(\)\.GetResult\(\);/);
  assert.match(host, /validationWatch\.ElapsedMilliseconds/);
  assert.match(host, /startupWatch\.ElapsedMilliseconds/);
});

test('1.69.6 Node hashing uses a large sequential buffer and pinned private Node skips redundant version process', () => {
  assert.match(host, /1024 \* 1024, FileOptions\.SequentialScan/);
  assert.match(host, /if \(bundled\)[\s\S]{0,260}?Version\.TryParse\(Program\.NodeVersion/);
  const nodeUsable = host.match(/private static bool NodeUsable\(string path\)[\s\S]*?private static bool IsHexDigit/);
  assert.ok(nodeUsable);
  assert.match(nodeUsable[0], /FileSha256\(full\)/);
  assert.ok(nodeUsable[0].indexOf('if (bundled)') < nodeUsable[0].indexOf('Arguments = "--version"'));
});

test('1.69.6 search cache hydration is deferred while transfer-log trimming stays race-safe before listen', () => {
  const lifecycle = read('lib/server/lifecycle-service.js');
  assert.doesNotMatch(server, /initUniversalSearchIndex\(\);/);
  assert.match(searchService, /async function loadIndexDeferred\([^)]*\)[\s\S]{0,900}?fs\.promises\.readFile\(INDEX_FILE/);
  assert.match(ocrService, /async function loadCacheDeferred\([^)]*\)[\s\S]{0,900}?fs\.promises\.readFile\(CACHE_FILE/);
  assert.match(searchService, /async function buildPostingsDeferred\([^)]*\)[\s\S]{0,1800}?setImmediate\(resolve\)/);
  assert.match(lifecycle, /trackTimer\(setTimeoutRef\(\(\) => \{[\s\S]{0,180}?runOptionalTask\('search-index', initUniversalSearchIndex\);[\s\S]{0,80}?\}, 750\)\);/);
  assert.match(lifecycle, /trackTimer\(setTimeoutRef\(\(\) => runOptionalTask\('windows-firewall',[\s\S]{0,160}?bootstrap\.ensureWindowsPortableFirewallAccess\(\)[\s\S]{0,80}?, 2500\)\);/);
  assert.match(coreState, /stateBootstrapService\.initialize\(\);/);
  assert.match(stateBootstrap, /initAccounts\(\);\n    trimLogIfNeeded\(\);\n    pruneHistory\(\);/);
});

test('1.70.21 Windows identities are component-scoped instead of release-coupled', () => {
  assert.match(launcher, /LauncherBuild = "launcher149-csharp"/);
  assert.match(launcher, /RuntimeBuild[\s\S]{0,700}?runtime-build\.txt/);
  assert.match(launcher, /RuntimeProtocol = "1"/);
  assert.match(launcher, /ServerHostProtocol = "1"/);
  assert.match(host, /ServerHostBuild = "serverhost139-csharp"/);
  assert.match(host, /ReadRuntimeBuild\(appDir\)/);
  assert.doesNotMatch(launcher, /1\.70\.1-launcher148-csharp/);
  assert.doesNotMatch(host, /1\.70\.1-launcher148-csharp|1\.70\.1-serverhost121-csharp/);
});
