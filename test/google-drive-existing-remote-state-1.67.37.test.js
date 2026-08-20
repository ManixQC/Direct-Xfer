'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageConnectorService } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function tempDir(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'dx-existing-remote-')); }

test('1.68.1 reads only safe Google scope metadata from an existing rclone remote', async () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'rclone.conf');
  fs.writeFileSync(configPath, [
    '[Direct-Xfer]',
    'type = drive',
    'scope = drive.file',
    'client_id = dxc_abcdefghijklmno',
    'client_secret = super-secret-value-that-must-never-be-returned',
    'token_url = https://oauth.example.test/v1/google/token',
    'token = {"access_token":"secret-access","refresh_token":"dxr_secret-refresh","scope":"https://www.googleapis.com/auth/drive.file"}',
    '',
  ].join('\n'));
  const service = new StorageConnectorService({ configPath, bin:'rclone' });
  const info = await service.googleRemoteInfo('Direct-Xfer');
  assert.deepEqual(info, {
    remote:'Direct-Xfer',
    type:'google-drive',
    configuredScope:'https://www.googleapis.com/auth/drive.file',
    grantedScope:'https://www.googleapis.com/auth/drive.file',
    broker:true,
  });
  assert.equal(JSON.stringify(info).includes('secret-access'), false);
  assert.equal(JSON.stringify(info).includes('secret-refresh'), false);
  assert.equal(JSON.stringify(info).includes('super-secret-value'), false);
});

test('1.68.1 Google OAuth start treats an existing remote as already connected rather than an OAuth error', () => {
  const route = read('lib/server/storage-connector-config.js');
  const start = route.indexOf("adminRouter.post('/storage/remotes/google-oauth/start'");
  const end = route.indexOf("adminRouter.get('/storage/oauth/google-session/:id'", start);
  const block = route.slice(start, end);
  assert.match(block, /existing\.includes\(remote\) && !replace/);
  assert.match(block, /googleRemoteInfo\(remote\)/);
  assert.match(block, /status:'already-connected'/);
  assert.match(block, /configuredScope/);
  assert.match(block, /grantedScope/);
  assert.doesNotMatch(block, /existing\.includes\(remote\) && !replace\) return res\.status\(409\)/);
});

test('1.68.1 connector UI does not show Waiting for Google for an existing configured remote', () => {
  const app = read('public/app.js');
  assert.match(app, /connector\.googleConfiguredScope/);
  assert.match(app, /if\(data\.status==='already-connected'\)/);
  assert.match(app, /connector\.remoteAlreadyConnected/);
  assert.match(app, /const displayed=granted\|\|configured/);
  assert.match(app, /data&&data\.status==='already-connected'/);
});

test('1.68.1 configuration page always reloads rclone remotes even before a Direct-Xfer connector record exists', () => {
  const app = read('public/app.js');
  const start = app.indexOf('async function refreshStorageConnectors(forceProbe)');
  const end = app.indexOf("if ($('connector-add'))", start);
  const block = app.slice(start, end);
  assert.match(block, /api\('GET', '\/api\/storage\/connectors'/);
  const summary=block.indexOf('/api/storage/connectors/summary');
  const canonical=block.indexOf("/api/storage/connectors', null, 30000");
  assert.ok(summary>=0&&canonical>summary);
  assert.doesNotMatch(block.slice(block.indexOf('if (!configured && !forceProbe)'), canonical), /return;/);
  assert.match(block, /skipped:!remotes\.length/);
  assert.match(app, /connector\.remoteReadyNoConnector/);
  assert.match(app, /storageConnectorRemotes\.length===1/);
});
