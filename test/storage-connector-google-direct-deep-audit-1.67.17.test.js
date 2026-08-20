'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageConnectorService } = require('../lib/storage-connectors');

const PRIVATE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength:1024 }).privateKey.export({ type:'pkcs8', format:'pem' });
function creds(overrides={}) {
  return {
    type:'service_account', project_id:'direct-xfer-test', private_key_id:'abc123',
    private_key:PRIVATE_KEY,
    client_email:'direct-xfer@direct-xfer-test.iam.gserviceaccount.com', client_id:'1234567890',
    auth_uri:'https://accounts.google.com/o/oauth2/auth', token_uri:'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url:'https://www.googleapis.com/oauth2/v1/certs', universe_domain:'googleapis.com',
    ...overrides,
  };
}
function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),'dx-google-audit-')); }

test('1.67.26 rejects malformed private keys and hostile Google credential endpoints before disk writes', async () => {
  const dir=tmp();
  try {
    const svc=new StorageConnectorService({bin:path.join(dir,'missing-rclone'),configPath:path.join(dir,'rclone','rclone.conf')});
    assert.throws(() => svc.validateGoogleServiceAccount(creds({private_key:'-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'})), /invalid-google-service-account-key/);
    assert.throws(() => svc.validateGoogleServiceAccount(creds({token_uri:'https://attacker.example/token'})), /invalid-google-service-account-token-uri/);
    assert.throws(() => svc.validateGoogleServiceAccount(creds({universe_domain:'attacker.example'})), /invalid-google-service-account-universe/);
    assert.equal(fs.existsSync(path.join(dir,'rclone','service-accounts')),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('1.67.26 replacement probes the new Google folder first and restores exact old config/key on failure', async () => {
  const dir=tmp();
  try {
    const config=path.join(dir,'rclone','rclone.conf');
    const keyDir=path.join(dir,'rclone','service-accounts');
    fs.mkdirSync(keyDir,{recursive:true});
    const oldConfig=Buffer.from('[existing-drive]\ntype = sftp\nhost = old.example\n');
    const oldKey=Buffer.from('{"old":true}\n');
    fs.writeFileSync(config,oldConfig);
    fs.writeFileSync(path.join(keyDir,'existing-drive.json'),oldKey);
    const log=path.join(dir,'calls.log');
    const fake=path.join(dir,'fake-rclone.js');
    fs.writeFileSync(fake, `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='listremotes'){console.log('existing-drive:');process.exit(0)}if(a[0]==='config'&&a[1]==='create'){fs.writeFileSync(process.env.RCLONE_CONFIG,'BROKEN\\n');process.exit(0)}if(a[0]==='config'&&a[1]==='delete'){process.exit(0)}if(a[0]==='lsf'){console.error('403 Forbidden: access denied');process.exit(1)}process.exit(0);`);
    const svc=new StorageConnectorService({bin:fake,configPath:config});
    await assert.rejects(
      svc.createGoogleServiceAccountRemote('existing-drive',creds(),{rootFolderId:'1AbCdEfGhIjKlMnOpQrStUv',replace:true}),
      (error)=>error && error.code==='connector-forbidden'
    );
    assert.deepEqual(fs.readFileSync(config),oldConfig);
    assert.deepEqual(fs.readFileSync(path.join(keyDir,'existing-drive.json')),oldKey);
    const calls=fs.readFileSync(log,'utf8').trim().split(/\n/).map(JSON.parse);
    const tempCreate=calls.find(a=>a[0]==='config'&&a[1]==='create'&&String(a[2]).includes('-dxcheck-'));
    assert.ok(tempCreate,'replacement must validate a temporary remote before touching the old one');
    assert.ok(calls.some(a=>a[0]==='lsf'&&String(a[1]).includes('-dxcheck-')),'temporary remote must be tested against Google');
    assert.equal(calls.some(a=>a[0]==='config'&&a[1]==='delete'&&a[2]==='existing-drive'),false,'old remote must not be deleted when preflight fails');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('1.67.26 successful direct Google setup verifies folder access and preserves resource keys', async () => {
  const dir=tmp();
  try {
    const log=path.join(dir,'calls.log');
    const fake=path.join(dir,'fake-rclone.js');
    fs.writeFileSync(fake, `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='listremotes')process.exit(0);process.exit(0);`);
    const svc=new StorageConnectorService({bin:fake,configPath:path.join(dir,'rclone','rclone.conf')});
    const result=await svc.createGoogleServiceAccountRemote('drive-direct',creds(),{rootFolderId:'1AbCdEfGhIjKlMnOpQrStUv',resourceKey:'0-AbCdEfGhIjKlMn'});
    assert.equal(result.verified,true);
    assert.equal(result.resourceKey,'0-AbCdEfGhIjKlMn');
    const calls=fs.readFileSync(log,'utf8').trim().split(/\n/).map(JSON.parse);
    const create=calls.find(a=>a[0]==='config'&&a[1]==='create'&&a[2]==='drive-direct');
    const idx=create.indexOf('resource_key');
    assert.ok(idx>0); assert.equal(create[idx+1],'0-AbCdEfGhIjKlMn');
    assert.ok(calls.some(a=>a[0]==='lsf'&&a[1]==='drive-direct:'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('1.67.26 logout purges in-memory Google service-account state and hidden connector fields', () => {
  const app=fs.readFileSync(path.resolve(__dirname,'..','public','app.js'),'utf8');
  assert.match(app,/connectorGoogleServiceAccount\s*=\s*null/);
  assert.match(app,/connectorConfigPendingGoogle\s*=\s*null/);
  assert.match(app,/querySelectorAll\('#connector-remote-wizard input, #connector-remote-wizard textarea'\)/);
  assert.match(app,/connector-config-google-service-email/);
  assert.match(app,/connectorConfigCloseAuthWindow\(\)/);
});

test('1.67.26 serializes Direct-Xfer rclone config mutations to avoid overlapping writes', async () => {
  const dir=tmp();
  try {
    const svc=new StorageConnectorService({bin:'rclone',configPath:path.join(dir,'rclone','rclone.conf')});
    let active=0, maxActive=0;
    const order=[];
    svc.run=async (args) => {
      if (args[0]==='listremotes') return {stdout:'',stderr:''};
      if (args[0]==='config'&&args[1]==='create') {
        const remote=args[2];
        active++; maxActive=Math.max(maxActive,active); order.push(`start:${remote}`);
        await new Promise(resolve=>setTimeout(resolve,35));
        order.push(`end:${remote}`); active--;
        return {stdout:'',stderr:''};
      }
      return {stdout:'',stderr:''};
    };
    await Promise.all([
      svc.configCreateStart('remote-a','sftp'),
      svc.configCreateStart('remote-b','sftp'),
    ]);
    assert.equal(maxActive,1,'rclone config mutations must never overlap');
    assert.deepEqual(order,['start:remote-a','end:remote-a','start:remote-b','end:remote-b']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('1.67.26 direct Google rollback failures surface a dedicated non-generic diagnostic', () => {
  const route=fs.readFileSync(path.resolve(__dirname,'..','lib','server','storage-connector-config.js'),'utf8');
  const app=fs.readFileSync(path.resolve(__dirname,'..','public','app.js'),'utf8');
  assert.match(route,/code === 'connector-rollback-failed' \? 500/);
  assert.match(app,/connector\.googleDirectRollbackFailed/);
  assert.match(app,/value==='connector-rollback-failed'/);
});

test('1.67.26 Windows ServerHost integrity manifest has no duplicate dictionary keys', () => {
  const host=fs.readFileSync(path.resolve(__dirname,'..','windows-server-host','Program.cs'),'utf8');
  const block=(host.match(/CriticalRuntimeSha256[\s\S]*?new Dictionary[\s\S]*?\{([\s\S]*?)\n\s*\};/)||[])[1]||'';
  const keys=[...block.matchAll(/\{\s*"([^"]+)"\s*,/g)].map(m=>m[1].toLowerCase());
  assert.ok(keys.length>10,'integrity manifest should be parsed');
  assert.equal(new Set(keys).size,keys.length,'duplicate integrity keys can break Dictionary initialization');
});
