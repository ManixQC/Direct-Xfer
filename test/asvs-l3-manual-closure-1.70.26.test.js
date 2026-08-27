'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyEvidenceBundle, REQUIRED_DEPLOYMENT_REQUIREMENTS } = require('../lib/server/asvs-l3-evidence');
const { createExternalCryptoProvider } = require('../lib/server/external-crypto-provider');
const { createStateStore } = require('../lib/server/state-store');
const { buildAsvsL3Report } = require('../lib/server/asvs-l3-policy');
const { createWebauthnService } = require('../lib/server/webauthn-service');
const { writeFakeProvider, writeEvidence, completeL3Config } = require('./helpers/asvs-l3-fixture');

function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx-l3-manual-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }
function read(rel) { return fs.readFileSync(path.join(__dirname,'..',rel),'utf8'); }

test('signed deployment evidence validates all formerly external ASVS requirements', (t) => {
  const dir=temp(t), ev=writeEvidence(dir);
  const result=verifyEvidenceBundle(ev.bundle,{ appVersion:'1.71.33', publicUrl:'https://direct-xfer.example', publicKey:ev.keyPair.publicKey });
  assert.equal(result.ok,true,JSON.stringify(result.failures));
  assert.equal(REQUIRED_DEPLOYMENT_REQUIREMENTS.length,22);
});

test('deployment evidence is release and public-origin bound', (t) => {
  const dir=temp(t), ev=writeEvidence(dir);
  assert.equal(verifyEvidenceBundle(ev.bundle,{appVersion:'1.70.30',publicUrl:'https://direct-xfer.example',publicKey:ev.keyPair.publicKey}).ok,false);
  assert.equal(verifyEvidenceBundle(ev.bundle,{appVersion:'1.71.33',publicUrl:'https://other.example',publicKey:ev.keyPair.publicKey}).ok,false);
});

test('deployment evidence rejects forged observations and stale expiry', (t) => {
  const dir=temp(t), ev=writeEvidence(dir), forged=JSON.parse(JSON.stringify(ev.bundle));
  forged.checks[0].observation.preloaded=false;
  assert.equal(verifyEvidenceBundle(forged,{appVersion:'1.71.33',publicUrl:'https://direct-xfer.example',publicKey:ev.keyPair.publicKey}).ok,false);
  assert.equal(verifyEvidenceBundle(ev.bundle,{appVersion:'1.71.33',publicUrl:'https://direct-xfer.example',publicKey:ev.keyPair.publicKey,now:ev.bundle.expiresAt+1}).ok,false);
});

test('external crypto provider requires hardware-backed non-exportable isolation', (t) => {
  const dir=temp(t), good=writeFakeProvider(dir);
  assert.ok(createExternalCryptoProvider({command:good}));
  const badDir=path.join(dir,'bad'); fs.mkdirSync(badDir); const bad=writeFakeProvider(badDir,{hardwareBacked:false});
  assert.throws(()=>createExternalCryptoProvider({command:bad}),/not-isolated/);
});

test('L3 state store delegates encryption to external provider and emits dxenc:2', (t) => {
  const dir=temp(t), provider=writeFakeProvider(dir), state={shares:[],settings:{x:1}};
  const store=createStateStore({fs,crypto,dataDir:dir,getState:()=>state,asvsL3Mode:true,cryptoProviderCommand:provider});
  assert.equal(store.persistNow(),true);
  const envelope=JSON.parse(fs.readFileSync(path.join(dir,'shares.json'),'utf8'));
  assert.equal(envelope.dxenc,2); assert.equal(envelope.provider,'external');
  assert.deepEqual(store.load(),state); store.close();
});

test('L3 state store refuses an application-process DATA_KEY', (t) => {
  const dir=temp(t), provider=writeFakeProvider(dir);
  assert.throws(()=>createStateStore({fs,crypto,dataDir:dir,getState:()=>({shares:[]}),asvsL3Mode:true,cryptoProviderCommand:provider,dataKey:'local-secret'}),/must-not-enter-app-process/);
});

test('L3 startup accepts complete signed evidence and rejects hop-count proxy trust', (t) => {
  const dir=temp(t), cfg=completeL3Config(dir);
  assert.equal(buildAsvsL3Report(cfg,{}).ok,true);
  const bad=buildAsvsL3Report({...cfg,TRUST_PROXY:1},{});
  assert.ok(bad.failures.some((row)=>row.id==='proxy.intermediary-trust'));
});

test('L3 WebAuthn policy requires approved hardware metadata for passkey authorization', (t) => {
  const dir=temp(t), provider=writeFakeProvider(dir);
  const account={id:'a',role:'owner',passkeys:[{hardwareBacked:true,backupEligible:false,aaguid:'00112233445566778899aabbccddeeff',attestationRootSha256:'a'.repeat(64)}]};
  const svc=createWebauthnService({APP_NAME:'DX',PUBLIC_URL:'https://dx.example',crypto,getSession:()=>null,getAccountById:()=>account,pwaDevices:()=>[],timingSafeEqualStr:(a,b)=>a===b,ASVS_L3_MODE:true,ASVS_L3_HARDWARE_AAGUIDS:'00112233445566778899aabbccddeeff',ASVS_L3_ATTESTATION_ROOT_SHA256:'a'.repeat(64),ASVS_L3_CRYPTO_COMMAND:provider});
  assert.equal(svc.l3HardwarePasskeyAllowed(account.passkeys[0]),true);
  assert.equal(svc.l3HardwarePasskeyAllowed({...account.passkeys[0],backupEligible:true}),false);
});

test('L3 passkey recovery lock survives loss of all credentials and requires phishing-resistant reauth', (t) => {
  const dir=temp(t), provider=writeFakeProvider(dir);
  const account={id:'a',role:'owner',passkeys:[],l3HardwarePasskeyEnrolled:true};
  const session={accountId:'a',authenticatedAt:Date.now(),authMethod:'password',phishingResistant:false};
  const svc=createWebauthnService({APP_NAME:'DX',PUBLIC_URL:'https://dx.example',crypto,getSession:()=>session,getAccountById:()=>account,pwaDevices:()=>[],timingSafeEqualStr:(a,b)=>a===b,ASVS_L3_MODE:true,ASVS_L3_HARDWARE_AAGUIDS:'00112233445566778899aabbccddeeff',ASVS_L3_ATTESTATION_ROOT_SHA256:'a'.repeat(64),ASVS_L3_CRYPTO_COMMAND:provider});
  let status=0,body=null; const res={status(v){status=v;return this;},json(v){body=v;return this;}};
  assert.equal(svc.freshPasskeyManagementAccount({},res),null); assert.equal(status,401); assert.equal(body.error,'reauth-required');
});

test('L3 source prevents factor and local-TLS fallback around the hardware boundary', () => {
  const pwa=read('lib/server/pwa-routes.js');
  assert.ok((pwa.match(/l3-last-hardware-passkey-required/g)||[]).length>=3);
  assert.match(pwa,/l3HardwarePasskeyAllowed/);
  const tls=read('lib/server/tls-manager.js');
  assert.match(tls,/if \(ASVS_L3_MODE\) return false;/);
  const settings=read('lib/server/settings-service.js');
  assert.match(settings,/asvs-l3-external-tls-required/);
  const restore=read('lib/server/restore-service.js');
  assert.match(restore,/asvs-l3-local-tls-restore-forbidden/);
});

test('ASVS matrix closes every MANUAL row without FAIL or REVIEW', () => {
  const matrix=read('security/ASVS-5.0.0-L3-MATRIX.md');
  assert.doesNotMatch(matrix,/\| \*\*MANUAL\*\* \|/);
  assert.doesNotMatch(matrix,/\| \*\*FAIL\*\* \|/);
  assert.doesNotMatch(matrix,/\| \*\*REVIEW\*\* \|/);
});
