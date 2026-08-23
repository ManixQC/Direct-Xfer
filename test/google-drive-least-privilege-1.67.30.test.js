'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {GoogleOAuthBrokerClient,GOOGLE_DRIVE_SCOPE_MAP}=require('../lib/google-oauth-broker-client');
const {StorageConnectorService}=require('../lib/storage-connectors');

const ROOT=path.resolve(__dirname,'..');
const read=(rel)=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const normalizeText=(value)=>String(value).replace(/\r\n?/g,'\n');

function brokerResponse(scope){
  const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id','123.apps.googleusercontent.com');
  auth.searchParams.set('redirect_uri','https://oauth.example.test/v1/google/callback');
  auth.searchParams.set('response_type','code');
  auth.searchParams.set('scope',scope);
  auth.searchParams.set('state','s'.repeat(32));
  auth.searchParams.set('code_challenge','c'.repeat(43));
  auth.searchParams.set('code_challenge_method','S256');
  return {id:'session_abcdefgh',pollToken:'p'.repeat(32),authUrl:auth.toString(),scope,expiresAt:Date.now()+600000};
}

test('1.67.30 broker client requests drive.file by default and explicit broader scopes only on demand',async()=>{
  const requests=[];
  const client=new GoogleOAuthBrokerClient({baseUrl:'https://oauth.example.test',version:'1.67.30',fetch:async(_url,options)=>{
    const body=JSON.parse(String(options.body||'{}')); requests.push(body);
    return new Response(JSON.stringify(brokerResponse(body.scope)),{status:201,headers:{'content-type':'application/json'}});
  }});
  const limited=await client.createSession();
  assert.equal(limited.scope,GOOGLE_DRIVE_SCOPE_MAP.limited);
  assert.equal(requests[0].scope,GOOGLE_DRIVE_SCOPE_MAP.limited);
  const full=await client.createSession({scope:'full'});
  assert.equal(full.scope,GOOGLE_DRIVE_SCOPE_MAP.full);
  assert.equal(requests[1].scope,GOOGLE_DRIVE_SCOPE_MAP.full);
});

test('1.67.30 refuses an old public broker that still forces full Drive scope',async()=>{
  const client=new GoogleOAuthBrokerClient({baseUrl:'https://oauth.example.test',version:'1.67.30',fetch:async()=>new Response(JSON.stringify(brokerResponse(GOOGLE_DRIVE_SCOPE_MAP.full)),{status:201,headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>client.createSession({scope:'limited'}),(e)=>e&&e.code==='oauth-broker-scope-upgrade-required');
  assert.match(read('public/app.js'),/oauthBrokerScopeUpgrade/);
});

test('1.67.30 broker credential validation rejects silent inheritance of old full-Drive grants',()=>{
  const client=new GoogleOAuthBrokerClient({baseUrl:'https://oauth.example.test'});
  const base={clientId:'dxc_abcdefghijk',clientSecret:'s'.repeat(32),tokenUrl:'https://oauth.example.test/v1/google/token',token:{access_token:'access',refresh_token:'dxr_abcdefghijklmnop',expiry:new Date(Date.now()+3600000).toISOString()}};
  assert.doesNotThrow(()=>client.validateCredential({...base,token:{...base.token,scope:GOOGLE_DRIVE_SCOPE_MAP.limited}},{scope:'limited'}));
  assert.throws(()=>client.validateCredential({...base,token:{...base.token,scope:`${GOOGLE_DRIVE_SCOPE_MAP.limited} ${GOOGLE_DRIVE_SCOPE_MAP.full}`}},{scope:'limited'}),(e)=>e&&e.code==='oauth-broker-scope-mismatch');
});

test('1.67.30 rclone remotes preserve the selected least-privilege Drive scope',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-drive-scope-'));
  const service=new StorageConnectorService({bin:'rclone',configPath:path.join(tmp,'rclone.conf')});
  const calls=[];
  service.configuredRemotes=async()=>[];
  service._snapshotFile=async()=>({exists:false,data:null});
  service._restoreFile=async()=>{};
  service.run=async(args)=>{calls.push(args.slice());return {stdout:'',stderr:''};};
  await service.createGoogleBrokerRemote('limited',{clientId:'dxc_abcdefghijk',clientSecret:'s'.repeat(32),tokenUrl:'https://oauth.example.test/v1/google/token',scope:GOOGLE_DRIVE_SCOPE_MAP.limited,token:{access_token:'access',refresh_token:'dxr_abcdefghijklmnop',scope:GOOGLE_DRIVE_SCOPE_MAP.limited}},{scope:'limited'});
  const create=calls.find((x)=>x[0]==='config'&&x[1]==='create');
  const i=create.indexOf('scope');
  assert.equal(create[i+1],'drive.file');
});

test('1.67.30 UI defaults to limited access and exposes restricted scopes as explicit choices',()=>{
  const html=read('public/index.html');
  const app=read('public/app.js');
  assert.match(html,/id="connector-google-access"/);
  assert.match(html,/<option value="limited" selected/);
  assert.match(html,/<option value="readonly"/);
  assert.match(html,/<option value="full"/);
  assert.match(app,/limited:'https:\/\/www\.googleapis\.com\/auth\/drive\.file'/);
  assert.match(app,/scope=String\(opts\.scope\|\|selectedGoogleDriveScope\(\)\)/);
  assert.match(app,/oauthConfig:\{scope\}/);
});

test('1.67.30 both broker runtimes default to drive.file and disable incremental broad-scope inheritance',()=>{
  for(const rel of ['oauth-broker/server.js','oauth-broker/cloudflare-worker/src/index.js']){
    const src=read(rel);
    assert.match(src,/https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
    assert.doesNotMatch(src,/include_granted_scopes/);
    assert.match(src,/drive\.readonly/);
  }
  assert.equal(normalizeText(read('oauth-broker/cloudflare-worker/src/index.js')),normalizeText(read('lib/assets/oauth-broker-worker.mjs')));
});
