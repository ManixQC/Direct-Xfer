'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {StorageConnectorService,safeRcloneErrorDetail}=require('../lib/storage-connectors');

function brokerCredentials(){
  return {
    clientId:'dxc_abcdefghijk',
    clientSecret:'s'.repeat(32),
    tokenUrl:'https://oauth.example.test/v1/google/token',
    token:{access_token:'access',refresh_token:'dxr_abcdefghijklmnop',scope:'https://www.googleapis.com/auth/drive.file',expiry:new Date(Date.now()+3600000).toISOString()},
  };
}

function writeWrapper(root,source){
  const file=path.join(root,'fake-rclone.js');
  fs.writeFileSync(file,source);
  return file;
}

test('1.68.2 creates the rclone config directory before the first Google remote is saved',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-dir-'));
  const configPath=path.join(tmp,'not-created','rclone','rclone.conf');
  const wrapper=writeWrapper(tmp,`'use strict';\nconst fs=require('fs'),path=require('path');\nconst a=process.argv.slice(2);\nif(a[0]==='listremotes')process.exit(0);\nif(a[0]==='config'&&a[1]==='create'){const f=process.env.RCLONE_CONFIG;if(!fs.existsSync(path.dirname(f))){console.error('Failed to save config: no such file or directory');process.exit(9);}fs.writeFileSync(f,'[gdrive]\\ntype = drive\\n');process.exit(0);}\nif(a[0]==='lsf')process.exit(0);\nprocess.exit(0);\n`);
  const service=new StorageConnectorService({bin:wrapper,configPath});
  const result=await service.createGoogleBrokerRemote('gdrive',brokerCredentials(),{scope:'limited'});
  assert.equal(result.verified,true);
  assert.equal(fs.existsSync(path.dirname(configPath)),true);
  assert.equal(fs.existsSync(configPath),true);
});

test('1.68.2 identifies rclone config-storage failures instead of connector-failed',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-storage-error-'));
  const configPath=path.join(tmp,'rclone','rclone.conf');
  const wrapper=writeWrapper(tmp,`'use strict';\nconst a=process.argv.slice(2);\nif(a[0]==='listremotes')process.exit(0);\nif(a[0]==='config'&&a[1]==='create'){console.error('Failed to save config after 10 tries: open rclone.conf: permission denied');process.exit(7);}\nprocess.exit(0);\n`);
  const service=new StorageConnectorService({bin:wrapper,configPath});
  await assert.rejects(()=>service.createGoogleBrokerRemote('gdrive',brokerCredentials(),{scope:'limited'}),(error)=>{
    assert.equal(error.code,'connector-config-storage');
    assert.equal(error.rcloneStage,'google-rclone-config-write');
    const detail=safeRcloneErrorDetail(error);
    assert.equal(detail.stage,'google-rclone-config-write');
    assert.equal(detail.exitCode,7);
    assert.match(detail.diagnostic,/Failed to save config/i);
    return true;
  });
});

test('1.68.2 distinguishes Google Drive verification failures and redacts broker credentials',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-probe-error-'));
  const service=new StorageConnectorService({bin:'rclone',configPath:path.join(tmp,'rclone','rclone.conf')});
  service.configuredRemotes=async()=>[];
  service._snapshotFile=async()=>({exists:false,data:null});
  service._restoreFile=async()=>{};
  service.run=async(args)=>{
    if(args[0]==='lsf'){
      const error=Object.assign(new Error('backend initialization exploded dxr_SUPERSECRETHANDLE dxc_SUPERSECRETCLIENT'),{code:'connector-failed',exitCode:17,rcloneStderr:'backend initialization exploded dxr_SUPERSECRETHANDLE dxc_SUPERSECRETCLIENT'});
      throw error;
    }
    return {stdout:'',stderr:''};
  };
  await assert.rejects(()=>service.createGoogleBrokerRemote('gdrive',brokerCredentials(),{scope:'limited'}),(error)=>{
    assert.equal(error.code,'connector-google-probe-failed');
    assert.equal(error.rcloneStage,'google-rclone-verify');
    const detail=safeRcloneErrorDetail(error);
    assert.equal(detail.exitCode,17);
    assert.equal(detail.diagnostic.includes('SUPERSECRET'),false);
    assert.match(detail.diagnostic,/redacted/i);
    return true;
  });
});

test('1.68.2 Google OAuth session API preserves a sanitized rclone diagnostic for the admin UI',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','server','storage-connector-config.js'),'utf8');
  const ui=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  assert.match(source,/item\.diagnostic=typeof safeRcloneErrorDetail === 'function'/);
  assert.match(source,/diagnostic:item\.diagnostic \|\| null/);
  assert.match(ui,/connectorConfigDiagnosticText\(data\)/);
  assert.match(ui,/diagnostic:data\.diagnostic\|\|null/);
  assert.match(ui,/connector-config-storage/);
});
