'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {StorageConnectorService}=require('../lib/storage-connectors');

function fakeService(){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-google-rclone-token-'));
  const service=new StorageConnectorService({bin:'rclone',configPath:path.join(tmp,'rclone.conf')});
  const calls=[];
  service.configuredRemotes=async()=>[];
  service._snapshotFile=async()=>({exists:false,data:null});
  service._restoreFile=async()=>{};
  service.run=async(args)=>{
    calls.push(args.slice());
    if(args[0]==='config'&&args[1]==='create'){
      const refreshIndex=args.indexOf('config_refresh_token');
      if(refreshIndex<0||args[refreshIndex+1]!=='false'){
        throw Object.assign(new Error('rclone attempted to replace supplied OAuth token'),{code:'connector-failed'});
      }
      assert.ok(args.includes('--obscure'),'OAuth client secrets must be force-obscured when written by rclone');
    }
    return {stdout:'',stderr:''};
  };
  return {service,calls};
}

function assertTokenConfigCommand(calls){
  const create=calls.find((args)=>args[0]==='config'&&args[1]==='create');
  assert.ok(create,'rclone config create must be called');
  const refresh=create.indexOf('config_refresh_token');
  assert.ok(refresh>0);
  assert.equal(create[refresh+1],'false');
  assert.ok(create.includes('--obscure'));
  assert.equal(create.includes('--no-output'),false,'Google remote creation must remain compatible with rclone releases that predate --no-output');
  const probe=calls.find((args)=>args[0]==='lsf');
  assert.ok(probe,'remote must still be verified after creation');
}

test('1.69.4 broker OAuth keeps the token already issued by Direct-Xfer instead of starting a second rclone OAuth flow',async()=>{
  const {service,calls}=fakeService();
  await service.createGoogleBrokerRemote('gdrive',{
    clientId:'dxc_abcdefghijk',
    clientSecret:'s'.repeat(32),
    tokenUrl:'https://oauth.example.test/v1/google/token',
    token:{access_token:'access',refresh_token:'dxr_abcdefghijklmnop',scope:'https://www.googleapis.com/auth/drive.file',expiry:new Date(Date.now()+3600000).toISOString()},
  },{scope:'limited'});
  assertTokenConfigCommand(calls);
});

test('1.69.4 local Web OAuth also keeps its completed Google token during rclone remote creation',async()=>{
  const {service,calls}=fakeService();
  await service.createGoogleOAuthTokenRemote('gdrive',{
    clientId:'1234567890-test.apps.googleusercontent.com',
    clientSecret:'GOCSPX-test-secret',
    token:{access_token:'access',refresh_token:'google-refresh',scope:'https://www.googleapis.com/auth/drive.file',expiry:new Date(Date.now()+3600000).toISOString()},
  },{scope:'limited'});
  assertTokenConfigCommand(calls);
});
