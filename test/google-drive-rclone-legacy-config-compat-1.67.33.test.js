'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {StorageConnectorService}=require('../lib/storage-connectors');

function writeLegacyRclone(root){
  const file=path.join(root,'legacy-rclone.js');
  fs.writeFileSync(file,`'use strict';\nconst fs=require('fs');\nconst a=process.argv.slice(2);\nif(a.includes('--no-output')){console.error('Error: unknown flag: --no-output');process.exit(1);}\nif(a[0]==='listremotes')process.exit(0);\nif(a[0]==='config'&&a[1]==='create'){const f=process.env.RCLONE_CONFIG;fs.writeFileSync(f,'[gdrive]\\ntype = drive\\n');process.exit(0);}\nif(a[0]==='lsf')process.exit(0);\nprocess.exit(0);\n`);
  return file;
}

function brokerCredentials(){
  return {
    clientId:'dxc_abcdefghijk',
    clientSecret:'s'.repeat(32),
    tokenUrl:'https://oauth.example.test/v1/google/token',
    token:{access_token:'access',refresh_token:'dxr_abcdefghijklmnop',scope:'https://www.googleapis.com/auth/drive.file',expiry:new Date(Date.now()+3600000).toISOString()},
  };
}

test('1.69.2 Google broker finalization works with rclone releases that do not implement --no-output',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-legacy-'));
  const service=new StorageConnectorService({bin:writeLegacyRclone(tmp),configPath:path.join(tmp,'rclone','rclone.conf')});
  const result=await service.createGoogleBrokerRemote('gdrive',brokerCredentials(),{scope:'limited'});
  assert.equal(result.verified,true);
});

test('1.69.2 local Google OAuth finalization also avoids the unsupported --no-output flag',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-legacy-web-'));
  const service=new StorageConnectorService({bin:writeLegacyRclone(tmp),configPath:path.join(tmp,'rclone','rclone.conf')});
  const result=await service.createGoogleOAuthTokenRemote('gdrive',{
    clientId:'1234567890-test.apps.googleusercontent.com',
    clientSecret:'GOCSPX-test-secret',
    token:{access_token:'access',refresh_token:'google-refresh',scope:'https://www.googleapis.com/auth/drive.file',expiry:new Date(Date.now()+3600000).toISOString()},
  },{scope:'limited'});
  assert.equal(result.verified,true);
});

test('1.69.2 service-account Google creation is compatible with the same legacy rclone command surface',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-legacy-sa-'));
  const service=new StorageConnectorService({bin:writeLegacyRclone(tmp),configPath:path.join(tmp,'rclone','rclone.conf')});
  const args=service._googleDirectArgs('gdrive','/tmp/service-account.json',{readOnly:false,rootFolderId:'abcdefghijk',resourceKey:'',impersonate:''});
  assert.equal(args.includes('--no-output'),false);
});
