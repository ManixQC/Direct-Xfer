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

test('1.69.0 launcher defers optional-component housekeeping until backend startup completes', () => {
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

test('1.69.0 ServerHost validates app runtime and Node concurrently', () => {
  assert.match(host, /var appValidation = Task\.Run\(EnsureApplicationRuntime\);/);
  assert.match(host, /var nodeValidation = Task\.Run\(EnsureNode\);/);
  assert.match(host, /var appDir = appValidation\.GetAwaiter\(\)\.GetResult\(\);[\s\S]{0,160}?var node = nodeValidation\.GetAwaiter\(\)\.GetResult\(\);/);
  assert.match(host, /validationWatch\.ElapsedMilliseconds/);
  assert.match(host, /startupWatch\.ElapsedMilliseconds/);
});

test('1.69.0 Node hashing uses a large sequential buffer and pinned private Node skips redundant version process', () => {
  assert.match(host, /1024 \* 1024, FileOptions\.SequentialScan/);
  assert.match(host, /if \(bundled\)[\s\S]{0,260}?Version\.TryParse\(Program\.NodeVersion/);
  const nodeUsable = host.match(/private static bool NodeUsable\(string path\)[\s\S]*?private static bool IsHexDigit/);
  assert.ok(nodeUsable);
  assert.match(nodeUsable[0], /FileSha256\(full\)/);
  assert.ok(nodeUsable[0].indexOf('if (bundled)') < nodeUsable[0].indexOf('Arguments = "--version"'));
});

test('1.69.0 search cache hydration is deferred while transfer-log trimming stays race-safe before listen', () => {
  const beforeListen = server.slice(0, server.indexOf('const onServerListening ='));
  assert.doesNotMatch(beforeListen, /initUniversalSearchIndex\(\);/);
  assert.match(server, /async function loadSearchIndexDeferred\([^)]*\)[\s\S]{0,700}?fs\.promises\.readFile\(SEARCH_INDEX_FILE/);
  assert.match(server, /async function loadSearchOcrCacheDeferred\([^)]*\)[\s\S]{0,700}?fs\.promises\.readFile\(SEARCH_OCR_CACHE_FILE/);
  assert.match(server, /async function buildSearchPostingsDeferred\([^)]*\)[\s\S]{0,1800}?setImmediate\(resolve\)/);
  assert.match(server, /const startupMaintenance = setTimeout\(\(\) => \{[\s\S]{0,500}?initUniversalSearchIndex\(\)[\s\S]{0,180}?\}, 750\);/);
  assert.match(server, /const firewallMaintenance = setTimeout\(\(\) => ensureWindowsPortableFirewallAccess\(\), 2500\);/);
  assert.match(server, /initAccounts\(\);\ntrimLogIfNeeded\(\);\npruneHistory\(\);/);
});

test('1.69.0 internal Windows build identifiers reflect startup optimization revision', () => {
  assert.match(launcher, /RuntimeAppBuild = "1\.69\.0-launcher125-csharp"/);
  assert.match(launcher, /ServerHostBuild = "1\.69\.0-serverhost98-csharp"/);
  assert.match(host, /RuntimeAppBuild = "1\.69\.0-launcher125-csharp"/);
  assert.match(host, /HostVersion = "1\.69\.0-serverhost98-csharp"/);
});
