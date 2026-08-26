'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyEvidenceBundle, signEvidenceBundle } = require('../lib/server/asvs-l3-evidence');
const { createExternalCryptoProvider, normalizeCommand } = require('../lib/server/external-crypto-provider');
const { createStateStore } = require('../lib/server/state-store');
const { createBackupService } = require('../lib/server/backup-service');
const { createSearchService } = require('../lib/server/search-service');
const { createOcrService } = require('../lib/server/ocr-service');
const { explicitTrustProxyPolicySafe } = require('../lib/server/asvs-l3-policy');
const { parseTrustProxy } = require('../lib/core-utils');
const { createWebauthnService } = require('../lib/server/webauthn-service');
const { writeFakeProvider, writeEvidence } = require('./helpers/asvs-l3-fixture');

function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx-l3-deep-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }

test('1.71.11 rejects observations older than seven days even when the bundle itself is current', (t) => {
  const dir=temp(t), ev=writeEvidence(dir), stale=JSON.parse(JSON.stringify(ev.bundle));
  const now=Date.now(); stale.generatedAt=now-1000; stale.expiresAt=now+3600000;
  stale.checks[0].observedAt=now-(8*24*60*60*1000);
  stale.signature=signEvidenceBundle(stale,ev.keyPair.privateKey.export({type:'pkcs8',format:'pem'})).signature;
  const result=verifyEvidenceBundle(stale,{appVersion:'1.71.11',publicUrl:'https://direct-xfer.example',publicKey:ev.keyPair.publicKey,now});
  assert.equal(result.ok,false); assert.ok(result.failures.some((row)=>row.id===stale.checks[0].id));
});

test('1.71.11 L3 state loader rejects plaintext and legacy dxenc:1 stores', (t) => {
  const dir=temp(t), provider=writeFakeProvider(dir), state={shares:[]};
  const store=createStateStore({fs,crypto,dataDir:dir,getState:()=>state,asvsL3Mode:true,cryptoProviderCommand:provider});
  fs.writeFileSync(path.join(dir,'shares.json'),JSON.stringify(state));
  assert.throws(()=>store.load(),(e)=>e && e.code==='ASVS_L3_PLAINTEXT_STORE_FORBIDDEN');
  fs.writeFileSync(path.join(dir,'shares.json'),JSON.stringify({dxenc:1,salt:'00'.repeat(16),iv:'00'.repeat(12),tag:'00'.repeat(16),data:''}));
  assert.throws(()=>store.load(),(e)=>e && e.code==='ASVS_L3_LEGACY_STORE_MIGRATION_REQUIRED');
  store.close();
});

test('1.71.11 L3 backups are encrypted even though DATA_KEY is absent', () => {
  let encrypted=0, decrypted=0;
  const enc=(json)=>{ encrypted++; return JSON.stringify({dxenc:2,provider:'external',data:Buffer.from(json).toString('base64')}); };
  const dec=(obj)=>{ decrypted++; return Buffer.from(obj.data,'base64').toString('utf8'); };
  const svc=createBackupService({fs,path,crypto,DATA_KEY:'',ASVS_L3_MODE:true,encryptStore:enc,decryptStore:dec});
  const bundle={kind:'dxbackup',store:{shares:[]}};
  const raw=svc.serializeBackup(bundle);
  assert.equal(JSON.parse(raw).dxenc,2); assert.equal(encrypted,1);
  assert.deepEqual(svc.parseBackup(raw).store.shares,[]); assert.equal(decrypted,1);
  assert.throws(()=>svc.parseBackup(JSON.stringify(bundle)),(e)=>e && e.code==='ASVS_L3_PLAINTEXT_BACKUP_FORBIDDEN');
});

test('1.71.11 purges plaintext search and OCR caches on L3 startup', (t) => {
  const dir=temp(t); const indexFile=path.join(dir,'search-index.json'), ocrFile=path.join(dir,'search-ocr-cache.json');
  fs.writeFileSync(indexFile,JSON.stringify({version:3,builtAt:1,docs:[{id:'sensitive',searchText:'secret'}]}));
  fs.writeFileSync(ocrFile,JSON.stringify({version:1,entries:{x:{text:'secret'}}}));
  const search=createSearchService({DATA_DIR:dir,DATA_KEY:'',ASVS_L3_MODE:true,HOST_ROOT:dir,INBOX_DIR:dir,encryptStore:(x)=>x,deserializeStore:JSON.parse,getState:()=>({}),getById:()=>null,listShares:()=>[],shareItems:()=>[],hostToContainer:(x)=>x,assertRealWithin:()=>true,resolveWithin:(x)=>x,firstExistingPhotoFile:()=>null,photoOriginalPaths:()=>[],ocrService:{}});
  search.loadIndexSync(); assert.equal(fs.existsSync(indexFile),false);
  const ocr=createOcrService({DATA_DIR:dir,DATA_KEY:'',ASVS_L3_MODE:true,encryptStore:(x)=>x,deserializeStore:JSON.parse});
  ocr.loadCacheSync(); assert.equal(fs.existsSync(ocrFile),false);
});

test('1.71.11 proxy trust accepts only valid non-global IP/CIDR literals', () => {
  assert.equal(parseTrustProxy('999.999.1.1/24'),false);
  assert.equal(parseTrustProxy('10.0.0.1/99'),false);
  assert.equal(explicitTrustProxyPolicySafe('0.0.0.0/0'),false);
  assert.equal(explicitTrustProxyPolicySafe('::/0'),false);
  assert.equal(explicitTrustProxyPolicySafe('999.999.1.1/24'),false);
  assert.equal(explicitTrustProxyPolicySafe('10.0.0.1/32'),true);
  assert.equal(explicitTrustProxyPolicySafe('2001:db8::1/128'),true);
});

test('1.71.11 refuses a symlinked external crypto command', (t) => {
  const dir=temp(t), provider=writeFakeProvider(dir), link=path.join(dir,'provider-link');
  try { fs.symlinkSync(provider,link); } catch (e) { if (process.platform==='win32') return; throw e; }
  assert.throws(()=>normalizeCommand(link),(e)=>e && e.code==='asvs-crypto-command-symlink-forbidden');
});

test('1.71.11 migrates the legacy audit chain to the isolated provider and updates the encrypted state anchor', (t) => {
  const dir=temp(t), providerFile=writeFakeProvider(dir), provider=createExternalCryptoProvider({command:providerFile});
  const legacySecret='legacy-audit-hmac-secret-with-more-than-32-bytes';
  const legacyKey=crypto.createHash('sha256').update('direct-xfer:audit-chain:v1\0'+legacySecret).digest();
  const auditPayload=(e)=>JSON.stringify([e.seq,e.at,e.action,e.actor,e.actorId,e.role,e.ip,e.detail,e.prevHash]);
  let prev=''; const entries=[];
  for (let i=1;i<=2;i++) { const e={seq:i,at:1700000000000+i,action:'legacy-'+i,actor:'owner',actorId:'a',role:'owner',ip:'127.0.0.1',detail:null,prevHash:prev}; e.hash=crypto.createHmac('sha256',legacyKey).update(auditPayload(e)).digest('hex'); prev=e.hash; entries.push(e); }
  const head={version:1,seq:2,hash:prev,seal:crypto.createHmac('sha256',legacyKey).update(`head|2|${prev}`).digest('hex'),at:Date.now()}; legacyKey.fill(0);
  fs.writeFileSync(path.join(dir,'audit-chain.log'),entries.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(dir,'audit-chain-head.json'),JSON.stringify(head));
  const state={shares:[],audit:entries.slice().reverse()}; const sealed=provider.encrypt(JSON.stringify(state),'direct-xfer-state-v2');
  fs.writeFileSync(path.join(dir,'shares.json'),JSON.stringify({dxenc:2,provider:'external',keyId:sealed.keyId,data:sealed.ciphertext}));
  const run=spawnSync(process.execPath,[path.join(__dirname,'..','scripts','asvs-l3-migrate-audit.js'),dir],{encoding:'utf8',env:{...process.env,ASVS_L3_LEGACY_AUDIT_HMAC_KEY:legacySecret,ASVS_L3_CRYPTO_COMMAND:providerFile}});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const migrated=fs.readFileSync(path.join(dir,'audit-chain.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(migrated.length,3); assert.equal(migrated[2].action,'audit-key-migrated');
  prev=''; for (const e of migrated) { assert.equal(e.prevHash,prev); assert.equal(e.hash,provider.hmac(auditPayload(e),'audit-hmac')); prev=e.hash; }
  const env=JSON.parse(fs.readFileSync(path.join(dir,'shares.json'),'utf8'));
  const migratedState=JSON.parse(provider.decrypt(env.data,'direct-xfer-state-v2',env.keyId));
  assert.equal(migratedState.audit[0].action,'audit-key-migrated'); assert.equal(migratedState.audit[0].hash,prev);
});


test('1.71.11 converts a 1.70.26 plaintext L3 backup to dxenc:2 offline', (t) => {
  const dir=temp(t), providerFile=writeFakeProvider(dir), input=path.join(dir,'old.dxbackup');
  const bundle={kind:'dxbackup',store:{shares:[],settings:{secret:'sensitive'}}}; fs.writeFileSync(input,JSON.stringify(bundle));
  const run=spawnSync(process.execPath,[path.join(__dirname,'..','scripts','asvs-l3-migrate-backup.js'),input],{encoding:'utf8',env:{...process.env,ASVS_L3_CRYPTO_COMMAND:providerFile}});
  assert.equal(run.status,0,run.stderr||run.stdout); const outer=JSON.parse(fs.readFileSync(input,'utf8')); assert.equal(outer.dxenc,2);
  const provider=createExternalCryptoProvider({command:providerFile}); const restored=JSON.parse(provider.decrypt(outer.data,'direct-xfer-state-v2',outer.keyId));
  assert.equal(restored.store.settings.secret,'sensitive'); assert.ok(fs.readdirSync(dir).some((name)=>name.includes('.pre-external-crypto-')));
});

test('1.71.11 accepts packed hardware attestation when x5c omits the pinned root certificate', (t) => {
  if (!spawnSync('openssl',['version'],{encoding:'utf8'}).stdout) return;
  const dir=temp(t), provider=writeFakeProvider(dir), rootKey=path.join(dir,'root.key'), rootPem=path.join(dir,'root.pem'), leafKey=path.join(dir,'leaf.key'), csr=path.join(dir,'leaf.csr'), leafPem=path.join(dir,'leaf.pem'), ext=path.join(dir,'leaf.ext');
  const run=(args)=>{ const r=spawnSync('openssl',args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  run(['ecparam','-name','prime256v1','-genkey','-noout','-out',rootKey]);
  run(['req','-x509','-new','-key',rootKey,'-sha256','-days','2','-subj','/CN=DX Test Attestation Root','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-out',rootPem]);
  run(['ecparam','-name','prime256v1','-genkey','-noout','-out',leafKey]); run(['req','-new','-key',leafKey,'-subj','/CN=DX Test Authenticator','-out',csr]);
  fs.writeFileSync(ext,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n');
  run(['x509','-req','-in',csr,'-CA',rootPem,'-CAkey',rootKey,'-CAcreateserial','-days','2','-sha256','-extfile',ext,'-out',leafPem]);
  const rootCert=new crypto.X509Certificate(fs.readFileSync(rootPem)); const leafCert=new crypto.X509Certificate(fs.readFileSync(leafPem));
  const rootFp=rootCert.fingerprint256.toLowerCase().replace(/[^a-f0-9]/g,''); const aaguid='00112233445566778899aabbccddeeff';
  const svc=createWebauthnService({APP_NAME:'DX',PUBLIC_URL:'https://dx.example',crypto,getSession:()=>null,getAccountById:()=>null,pwaDevices:()=>[],timingSafeEqualStr:(a,b)=>a===b,ASVS_L3_MODE:true,ASVS_L3_HARDWARE_AAGUIDS:aaguid,ASVS_L3_ATTESTATION_ROOT_SHA256:rootFp,ASVS_L3_ATTESTATION_ROOT_FILES:rootPem,ASVS_L3_CRYPTO_COMMAND:provider});
  const authData=crypto.randomBytes(64), clientHash=crypto.randomBytes(32), signed=Buffer.concat([authData,clientHash]);
  const leafPrivate=crypto.createPrivateKey(fs.readFileSync(leafKey)); const sig=crypto.sign('sha256',signed,leafPrivate);
  const att=new Map([['fmt','packed'],['attStmt',new Map([['alg',-7],['sig',sig],['x5c',[leafCert.raw]]])]]);
  const result=svc.verifyL3HardwareAttestation(att,authData,clientHash,{aaguid,be:false},['internal']);
  assert.equal(result.hardwareBacked,true); assert.equal(result.attestationRootSha256,rootFp);
});
