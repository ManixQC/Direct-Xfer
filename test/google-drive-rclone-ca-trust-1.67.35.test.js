'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {StorageConnectorService,safeRcloneErrorDetail}=require('../lib/storage-connectors');

function writeWrapper(root,source){
  const file=path.join(root,'fake-rclone.js');
  fs.writeFileSync(file,source);
  return file;
}
function brokerCredentials(){
  return {
    clientId:'dxc_abcdefghijk', clientSecret:'s'.repeat(32), tokenUrl:'https://oauth.example.test/v1/google/token',
    token:{access_token:'access',refresh_token:'dxr_abcdefghijklmnop',scope:'https://www.googleapis.com/auth/drive.file',expiry:new Date(Date.now()+3600000).toISOString()},
  };
}

test('1.69.4 gives rclone a merged CA bundle even on a minimal runtime',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-ca-'));
  const configPath=path.join(tmp,'rclone','rclone.conf');
  const wrapper=writeWrapper(tmp,`'use strict';\nconst fs=require('fs');\nconst a=process.argv.slice(2);\nconst ca=process.env.SSL_CERT_FILE||'';\nif(!ca||!fs.existsSync(ca)||!fs.readFileSync(ca,'utf8').includes('-----BEGIN CERTIFICATE-----')){console.error('x509: certificate signed by unknown authority');process.exit(11);}\nif(a[0]==='listremotes')process.exit(0);\nif(a[0]==='config'&&a[1]==='create'){fs.mkdirSync(require('path').dirname(process.env.RCLONE_CONFIG),{recursive:true});fs.writeFileSync(process.env.RCLONE_CONFIG,'[gdrive]\\ntype = drive\\n');process.exit(0);}\nif(a[0]==='lsf')process.exit(0);\nprocess.exit(0);\n`);
  const service=new StorageConnectorService({bin:wrapper,configPath,caBundlePath:path.join(tmp,'rclone','dx-ca.pem')});
  const result=await service.createGoogleBrokerRemote('gdrive',brokerCredentials(),{scope:'limited'});
  assert.equal(result.verified,true);
  assert.equal(fs.existsSync(path.join(tmp,'rclone','dx-ca.pem')),true);
  assert.match(fs.readFileSync(path.join(tmp,'rclone','dx-ca.pem'),'utf8'),/-----BEGIN CERTIFICATE-----/);
});

test('1.69.4 classifies unknown CA failures instead of generic Google probe failure',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-rclone-ca-error-'));
  const configPath=path.join(tmp,'rclone','rclone.conf');
  const wrapper=writeWrapper(tmp,`'use strict';\nconst fs=require('fs'),path=require('path');\nconst a=process.argv.slice(2);\nif(a[0]==='listremotes')process.exit(0);\nif(a[0]==='config'&&a[1]==='create'){fs.mkdirSync(path.dirname(process.env.RCLONE_CONFIG),{recursive:true});fs.writeFileSync(process.env.RCLONE_CONFIG,'[gdrive]\\ntype = drive\\n');process.exit(0);}\nif(a[0]==='lsf'){console.error('Failed to create file system for "gdrive:": couldn\\'t find root directory ID: Get "https://www.googleapis.com/drive/v3/files/root": tls: failed to verify certificate: x509: certificate signed by unknown authority');process.exit(1);}\nprocess.exit(0);\n`);
  const service=new StorageConnectorService({bin:wrapper,configPath});
  await assert.rejects(()=>service.createGoogleBrokerRemote('gdrive',brokerCredentials(),{scope:'limited'}),(error)=>{
    assert.equal(error.code,'connector-tls-ca-untrusted');
    assert.equal(error.rcloneStage,'google-rclone-verify');
    const detail=safeRcloneErrorDetail(error);
    assert.match(detail.diagnostic,/unknown authority/i);
    return true;
  });
});

test('1.69.4 Docker image explicitly installs and validates ca-certificates',()=>{
  const docker=fs.readFileSync(path.join(__dirname,'..','Dockerfile'),'utf8');
  assert.match(docker,/apt-get install[\s\S]*ca-certificates/);
  assert.match(docker,/update-ca-certificates/);
  assert.match(docker,/test -s \/etc\/ssl\/certs\/ca-certificates\.crt/);
});

test('1.69.4 admin UI explains an untrusted CA without suggesting TLS bypass',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  assert.match(ui,/connector-tls-ca-untrusted/);
  assert.match(ui,/connector\.tlsCaUntrusted/);
  assert.doesNotMatch(ui,/--no-check-certificate/);
});
