'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageConnectorService, connectorBackendType, OAUTH_CONNECTOR_TYPES } = require('../lib/storage-connectors');
const ROOT = path.resolve(__dirname, '..');

function fakeRclone(dir) {
  const file = path.join(dir, 'fake-rclone.js');
  fs.writeFileSync(file, String.raw`
const fs=require('fs'),path=require('path'); const a=process.argv.slice(2), conf=process.env.RCLONE_CONFIG, db=conf+'.json';
function read(){try{return JSON.parse(fs.readFileSync(db,'utf8'))}catch{return {}}} function save(x){fs.mkdirSync(path.dirname(conf),{recursive:true});fs.writeFileSync(db,JSON.stringify(x));}
if(a[0]==='version'){console.log('rclone v1.70.0');process.exit(0)}
if(a[0]==='listremotes'){for(const k of Object.keys(read()))console.log(k+':');process.exit(0)}
if(a[0]==='config'&&a[1]==='create'){const x=read();x[a[2]]={type:a[3]};save(x);console.log(JSON.stringify({State:'*oauth-islocal,,,',Option:{Name:'config_is_local',Help:'Use browser?',Default:true,Examples:[{Value:'true',Help:'Yes'},{Value:'false',Help:'No'}],Required:false,IsPassword:false,Type:'bool',Exclusive:true},Error:''}));process.exit(0)}
if(a[0]==='config'&&a[1]==='update'){const st=a[a.indexOf('--state')+1];if(st==='*oauth-islocal,,,')console.log(JSON.stringify({State:'*oauth-remote,,,',Option:null,Error:''}));else if(st==='*oauth-remote,,,')console.log(JSON.stringify({State:'*oauth-authorize,,,',Option:{Name:'config_token',Help:'Run this command:\n    rclone authorize "drive" "eyJjbGllbnRfaWQiOiJkeC10ZXN0In0="\nThen paste the result.',Default:'',Examples:[],Required:true,IsPassword:true,Type:'string',Exclusive:false},Error:''}));else console.log(JSON.stringify({State:'',Option:null,Error:''}));process.exit(0)}
if(a[0]==='config'&&a[1]==='delete'){const x=read();delete x[a[2]];save(x);process.exit(0)}
if(a[0]==='authorize'){if(a[1]!=='drive'||a[2]!=='eyJjbGllbnRfaWQiOiJkeC10ZXN0In0='){console.error('invalid_client: missing remote config blob');process.exit(9)}const http=require('http');const srv=http.createServer((req,res)=>{if(req.url.startsWith('/auth?')){res.statusCode=302;res.setHeader('Location','https://accounts.example.test/oauth?state=teststate&redirect_uri=http%3A%2F%2Flocalhost%3A53682%2F');res.end();return}if(req.url.startsWith('/?')){res.statusCode=200;res.end('ok');setTimeout(()=>{console.log('Paste the following into your remote machine --->');console.log('{"access_token":"secret","refresh_token":"refresh"}');console.log('<---End paste');srv.close(()=>process.exit(0));},15);return}res.statusCode=404;res.end();});srv.listen(53682,'127.0.0.1',()=>console.error('NOTICE: http://127.0.0.1:53682/auth?state=teststate'));setTimeout(()=>{srv.close(()=>process.exit(4));},4000).unref();return}
process.exit(3);
`);
  return file;
}

test('1.67.26 maps connector types to the rclone backend used by the login wizard', () => {
  assert.equal(connectorBackendType('google-drive'), 'drive');
  assert.equal(connectorBackendType('onedrive'), 'onedrive');
  assert.ok(OAUTH_CONNECTOR_TYPES.has('dropbox'));
  assert.equal(connectorBackendType('invalid'), null);
});

test('1.67.26 normal Google Drive configuration can start with rclone built-in OAuth client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-default-oauth-'));
  const service = new StorageConnectorService({ bin:fakeRclone(dir), configPath:path.join(dir, 'rclone.conf') });
  const first = await service.configCreateStart('normaldrive', 'google-drive', { parameters:{} });
  assert.equal(first.option.Name, 'config_is_local');
  assert.deepEqual(await service.configuredRemotes(), ['normaldrive']);
});

test('1.67.26 first-time Google Drive configuration exposes OAuth question and keeps token server-side', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-config-'));
  const service = new StorageConnectorService({ bin:fakeRclone(dir), configPath:path.join(dir, 'rclone.conf') });
  const googleParameters = {client_id:'123456-test.apps.googleusercontent.com',client_secret:'GOCSPX-test-secret'};
  const first = await service.configCreateStart('mydrive', 'google-drive', { parameters:googleParameters });
  assert.equal(first.option.Name, 'config_is_local');
  const prepared = await service.prepareOAuthAuthorization('mydrive', 'google-drive', first.state, { connectorType:'google-drive', parameters:googleParameters });
  assert.equal(prepared.question.option.Name, 'config_token');
  assert.deepEqual(prepared.authorizeArgs, ['drive', 'eyJjbGllbnRfaWQiOiJkeC10ZXN0In0=']);
  let url = '';
  const auth = service.startOAuthAuthorization('google-drive', { authorizeArgs:prepared.authorizeArgs, timeoutMs:5000, onUrl:(value) => { url=value; } });
  while (!url) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(url, /^https:\/\/accounts\.example\.test\/oauth\?/);
  await assert.rejects(() => auth.acceptCallback('http://127.0.0.1:53682/?state=wrong&code=testcode'), /oauth-callback-state/);
  await assert.rejects(() => auth.acceptCallback('http://example.com:53682/?state=teststate&code=testcode'), /oauth-callback-invalid/);
  await auth.acceptCallback('http://localhost:53682/?state=teststate&code=testcode');
  const authorized = await auth.promise;
  assert.match(authorized.token, /access_token/);
  const done = await service.configContinueToQuestion('mydrive', prepared.question.state, authorized.token, { connectorType:'google-drive', parameters:googleParameters });
  assert.equal(done.done, true);
  assert.deepEqual(await service.configuredRemotes(), ['mydrive']);
});

test('1.67.26 standard Configuration exposes an in-app rclone connection wizard and remote-server fallback', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const adminStorage = fs.readFileSync(path.join(ROOT, 'lib/server/admin-storage-routes.js'), 'utf8');
  const configModule = fs.readFileSync(path.join(ROOT, 'lib/server/storage-connector-config.js'), 'utf8');
  assert.match(html, /id="connector-configure-remote"/);
  assert.match(html, /id="connector-config-oauth-local"/);
  assert.match(html, /id="connector-config-oauth-remote"/);
  assert.match(html, /id="connector-config-callback-url"/);
  assert.match(html, /id="connector-config-google-client-id"/);
  assert.match(html, /id="connector-config-google-client-secret"/);
  assert.doesNotMatch(html, /id="connector-config-google-json"/);
  assert.match(html, /id="connector-config-google-callback"/);
  assert.match(html, /class="connector-google-guide"/);
  assert.match(html, /connector\.googleQuickSetupTitle/);
  assert.match(html, /connector-google-profile-status/);
  assert.match(html, /console\.cloud\.google\.com\/apis\/library\/drive\.googleapis\.com/);
  assert.match(html, /console\.cloud\.google\.com\/auth\/clients/);
  assert.match(app, /connector\.googleGuideStep1/);
  assert.match(app, /connector\.googleGuideStep7/);
  assert.match(app, /Application Web/);
  assert.match(app, /Test user|utilisateur.*test/i);
  assert.match(app, /rclone authorize "\$\{data\.backend\}"/);
  assert.match(adminStorage, /createStorageConnectorConfigRoutes/);
  assert.match(configModule, /\/storage\/remotes\/config\/:id\/oauth/);
  assert.match(configModule, /oauth\/callback/);
  assert.match(app, /submitConnectorOAuthCallback/);
  assert.match(app, /\/api\/storage\/remotes\/google-oauth\/start/);
  assert.match(configModule, /\/storage\/oauth\/google\/callback/);
  assert.match(app, /oauthConfig:\s*opts\.oauthConfig/);
  assert.doesNotMatch(configModule, /token:\s*token[^\n]*res\.json/);
});
