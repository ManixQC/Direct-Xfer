'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

test('public HTTP/Web Storage/download composition is extracted from server.js', () => {
  const server = read('server.js');
  const composition = read('lib/server/public-http-application.js');
  assert.match(server, /require\('\.\/lib\/server\/public-http-application'\)/);
  assert.match(server, /createPublicHttpApplication\(\{/);
  assert.doesNotMatch(server, /createPublicPages\(/);
  assert.doesNotMatch(server, /createPublicShareRoutes\(/);
  assert.doesNotMatch(server, /createWebStorageShareTools\(/);
  assert.doesNotMatch(server, /createWebStorageWritableTools\(/);
  assert.doesNotMatch(server, /initializeDownloadService\(\{/);
  assert.match(composition, /createPublicPages\(\{/);
  assert.match(composition, /createPublicShareRoutes\(\{/);
  assert.match(composition, /createWebStorageShareTools\(\{/);
  assert.match(composition, /createWebStorageWritableTools\(\{/);
  assert.match(composition, /shareMediaTransferApplication\.initializeDownloadService/);
  assert.ok(server.split('\n').length < 850, `server.js should stay compact after public HTTP extraction (${server.split('\n').length} lines)`);
});

test('public HTTP composition owns delayed public security and context publication', () => {
  const server = read('server.js');
  const composition = read('lib/server/public-http-application.js');
  assert.match(composition, /securityAuthApplication\.initializePublicSecurity/);
  assert.match(composition, /\['public-pages', publicPages\]/);
  assert.match(composition, /\['public-access', publicAccessService\]/);
  assert.match(composition, /\['public-abuse', publicAbuseService\]/);
  assert.match(composition, /\['public-share', publicShareRoutes\]/);
  assert.match(composition, /domainPhase = 'idle'/);
  assert.match(composition, /applicationContext\.current\(name\) != null/);
  assert.match(composition, /applicationContext\.registerMany\(applicationDomains\)/);
  assert.match(composition, /applicationDomainEntries/);
  assert.match(server, /publishApplicationGraph\(\{/);
});

test('public HTTP composition keeps writable reception separate while exporting shared Web Storage adapters', () => {
  const server = read('server.js');
  const composition = read('lib/server/public-http-application.js');
  const publication = read('lib/server/application-publication.js');
  assert.match(publication, /attachReceptionCollaborationRoutes\(/);
  assert.doesNotMatch(composition, /attachReceptionCollaborationRoutes\(/);
  for (const name of [
    'createWebStorageUploadHandler', 'webStorageConnectorStatus', 'webStorageList',
    'webStorageStat', 'webStorageWalkFiles', 'webStorageImportMeta', 'webStorageWritable',
    'sendError', 'validDownloadResumeId', 'pruneDownloadResumeSessions',
    'clearDownloadRuntimeState', 'parseHotlinkHosts',
  ]) {
    assert.match(composition, new RegExp(`\\b${name}\\b`), `${name} should be owned/exported by public HTTP composition`);
  }
});

test('Windows runtime integrity manifest protects public HTTP composition', () => {
  const source = read('lib/server/public-http-application.js');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "lib/server/public-http-application\\.js", "${hash}" \\}`));
});
