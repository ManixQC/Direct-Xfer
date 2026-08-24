'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageConnectorService, CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType } = require('../lib/storage-connectors');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');

const ROOT = path.resolve(__dirname, '..');
function tempDir(){ return fs.mkdtempSync(path.join(os.tmpdir(),'dx-google-direct-')); }
const TEST_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength:2048 }).privateKey.export({ type:'pkcs8', format:'pem' });
function credentials(){
  return {
    type:'service_account', project_id:'direct-xfer-test', private_key_id:'abc123',
    private_key:TEST_PRIVATE_KEY,
    client_email:'direct-xfer@direct-xfer-test.iam.gserviceaccount.com', client_id:'1234567890',
    auth_uri:'https://accounts.google.com/o/oauth2/auth', token_uri:'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url:'https://www.googleapis.com/oauth2/v1/certs', universe_domain:'googleapis.com',
  };
}

test('1.67.26 direct Google Drive method creates a service-account remote without OAuth', async () => {
  const dir=tempDir();
  try{
    const log=path.join(dir,'args.log');
    const fake=path.join(dir,'fake-rclone.js');
    fs.writeFileSync(fake, `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='version')console.log('rclone v1.75.0');if(a[0]==='listremotes')process.exit(0);process.exit(0);`);
    const config=path.join(dir,'rclone','rclone.conf');
    const svc=new StorageConnectorService({bin:fake,configPath:config});
    const result=await svc.createGoogleServiceAccountRemote('gdirect',credentials(),{rootFolderId:'1AbCdEfGhIjKlMnOpQrStUv',resourceKey:'0-AbCdEfGhIjKlMn',readOnly:true});
    assert.equal(result.remote,'gdirect');
    assert.equal(result.clientEmail,'direct-xfer@direct-xfer-test.iam.gserviceaccount.com');
    const keyFile=path.join(dir,'rclone','service-accounts','gdirect.json');
    assert.equal(fs.existsSync(keyFile),true);
    assert.equal(JSON.parse(fs.readFileSync(keyFile,'utf8')).client_email,result.clientEmail);
    const calls=fs.readFileSync(log,'utf8').trim().split(/\n/).map(JSON.parse);
    const create=calls.find(a=>a[0]==='config'&&a[1]==='create');
    assert.ok(create);
    assert.deepEqual(create.slice(0,4),['config','create','gdirect','drive']);
    assert.ok(create.includes('service_account_file'));
    assert.ok(create.includes(keyFile));
    assert.ok(create.includes('drive.readonly'));
    assert.ok(create.includes('root_folder_id'));
    assert.ok(create.includes('resource_key'));
    assert.ok(calls.some(a=>a[0]==='lsf'&&a[1]==='gdirect:'));
    assert.equal(create.includes('--non-interactive'),false);
    assert.equal(create.some(v=>String(v).includes('config_is_local')),false);
    assert.equal(create.some(v=>String(v).includes('authorize')),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('1.67.26 direct Google Drive route extracts a folder ID and never needs OAuth credentials', async () => {
  const routes=new Map();
  const adminRouter={post(route,...handlers){routes.set(`POST ${route}`,handlers.at(-1));},get(){},delete(){}};
  let captured=null;
  const service={
    async capabilities(){return {available:true};},
    async createGoogleServiceAccountRemote(remote,creds,options){captured={remote,creds,options};return {remote,clientEmail:creds.client_email,rootFolderId:options.rootFolderId,readOnly:options.readOnly,impersonate:''};},
    async deleteRemote(){return true;},
  };
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(){},storageConnectorService:service,googleOAuthProfileStore:null,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.4',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{}});
  const handler=routes.get('POST /storage/remotes/google-direct');assert.equal(typeof handler,'function');
  const req={body:{remote:'drive-direct',folder:'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?resourcekey=0-AbCdEfGhIjKlMn',credentials:credentials(),readOnly:false},session:{accountId:'a1'}};
  let statusCode=200,payload;const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;}};
  await handler(req,res);
  assert.equal(statusCode,201);assert.equal(payload.method,'service-account');
  assert.equal(captured.options.rootFolderId,'1AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(captured.options.resourceKey,'0-AbCdEfGhIjKlMn');
  assert.equal(captured.options.readOnly,false);
  assert.equal(captured.creds.client_email,credentials().client_email);
});

test('1.67.26 UI uses standard Google account sign-in and no service-account JSON in the modal', () => {
  const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'public/app.js'),'utf8');
  assert.match(app,/connector\.googleStandardReady/);
  assert.doesNotMatch(html,/id="connector-config-google-service-advanced"/);
  assert.doesNotMatch(html,/id="connector-config-google-service-json"/);
  assert.doesNotMatch(html,/id="connector-config-google-json"/);
  assert.doesNotMatch(html,/Importer la clé JSON|Connecter Google Drive sans OAuth/);
  assert.match(html,/id="connector-config-google-credentials"/);
  assert.match(html,/data-i18n="connector\.googleAdminHint"/);
  assert.match(app,/async function openConnectorConfigWizard[\s\S]*startGoogleWebOAuth/);
  assert.doesNotMatch(app.match(/async function openConnectorConfigWizard[\s\S]*?\n}/)?.[0]||'',/refreshGoogleOAuthProfileStatus|showGoogleOAuthProfileSetup/);
  assert.doesNotMatch(app,/if\(opts\.useServiceAccount\)/);
  assert.match(app,/async function startGoogleWebOAuth[\s\S]*connectorConfigPrepareAuthWindow\(\{type:'google-drive'\},true\)/);
  // Service-account API compatibility can remain server-side, but it is no longer a user-facing connection method.
  assert.match(app,/\/api\/storage\/remotes\/google-direct/);
});

test('1.67.26 direct Google Drive validates the service-account key before replacing an existing remote', async () => {
  const routes = new Map();
  const adminRouter = { post(route, ...handlers){ routes.set(`POST ${route}`, handlers.at(-1)); }, get(){}, delete(){} };
  let deleted = false;
  const service = {
    async capabilities(){ return { available:true }; },
    validateGoogleServiceAccount(){ const error = new Error('invalid'); error.code = 'google-service-account-invalid'; throw error; },
    async deleteRemote(){ deleted = true; return true; },
    async createGoogleServiceAccountRemote(){ throw new Error('should not be called'); },
  };
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(){},storageConnectorService:service,googleOAuthProfileStore:null,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.4',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{}});
  const handler = routes.get('POST /storage/remotes/google-direct');
  const req = {body:{remote:'existing-drive',folder:'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv',credentials:{type:'service_account'},replace:true},session:{accountId:'a1'}};
  let statusCode = 200, payload;
  const res = {status(c){statusCode=c;return this;},json(v){payload=v;return this;}};
  await handler(req,res);
  assert.equal(statusCode,400);
  assert.equal(payload.error,'google-service-account-invalid');
  assert.equal(deleted,false);
});
