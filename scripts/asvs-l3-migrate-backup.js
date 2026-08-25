'use strict';

// Offline converter for older Direct-Xfer backups. It accepts the plaintext
// .dxbackup format accidentally emitted by 1.70.26 L3 and the legacy dxenc:1
// format from <=1.70.25, validates the inner backup shape, and writes dxenc:2
// through the isolated provider. Never run the legacy DATA_KEY in the server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExternalCryptoProvider } = require('../lib/server/external-crypto-provider');
const SCRYPT_OPTIONS = Object.freeze({ N:16384, r:8, p:1, maxmem:64*1024*1024 });
function fail(message, code=1) { console.error(message); process.exit(code); }
const input=process.argv[2] && path.resolve(process.argv[2]);
const output=process.argv[3] ? path.resolve(process.argv[3]) : input;
if (!input) fail('Usage: node scripts/asvs-l3-migrate-backup.js <input.dxbackup> [output.dxbackup]');
const providerCommand=String(process.env.ASVS_L3_CRYPTO_COMMAND||'').trim();
if (!providerCommand) fail('ASVS_L3_CRYPTO_COMMAND is required.');
let stat,raw;
try { stat=fs.lstatSync(input); if(!stat.isFile()||stat.isSymbolicLink()) fail('Input must be a regular non-symlink file.'); if(stat.size<=0||stat.size>512*1024*1024) fail('Backup has an invalid size.'); raw=fs.readFileSync(input,'utf8'); }
catch(e){ fail(`Could not read backup: ${e.message}`); }
let outer; try{outer=JSON.parse(raw);}catch(_){fail('Backup is not valid JSON.');}
if (outer && outer.dxenc===2) { console.log('Backup already uses dxenc:2; no migration needed.'); process.exit(0); }
let plaintext;
if (outer && outer.dxenc===1) {
  const legacy=String(process.env.ASVS_L3_LEGACY_DATA_KEY||process.env.DATA_KEY||'');
  if(!legacy) fail('ASVS_L3_LEGACY_DATA_KEY (or DATA_KEY for this offline command only) is required for dxenc:1.');
  if(!/^[a-f0-9]{32}$/i.test(String(outer.salt||''))||!/^[a-f0-9]{24}$/i.test(String(outer.iv||''))||!/^[a-f0-9]{32}$/i.test(String(outer.tag||''))||typeof outer.data!=='string') fail('Legacy backup envelope is malformed.');
  try { const key=crypto.scryptSync(legacy,Buffer.from(outer.salt,'hex'),32,SCRYPT_OPTIONS); try { const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(outer.iv,'hex')); d.setAuthTag(Buffer.from(outer.tag,'hex')); plaintext=Buffer.concat([d.update(Buffer.from(outer.data,'base64')),d.final()]); } finally { key.fill(0); } }
  catch(_){ fail('Legacy DATA_KEY is invalid or the backup failed authentication.'); }
} else {
  plaintext=Buffer.from(raw,'utf8');
}
let bundle;
try { bundle=JSON.parse(plaintext.toString('utf8')); if(!bundle||bundle.kind!=='dxbackup'||!bundle.store||!Array.isArray(bundle.store.shares)) throw new Error('invalid Direct-Xfer backup shape'); }
catch(e){ plaintext.fill(0); fail(`Backup payload is invalid: ${e.message}`); }
let provider; try{provider=createExternalCryptoProvider({command:providerCommand});}catch(e){plaintext.fill(0);fail(`External crypto provider failed self-test: ${e.message}`);}
let migrated; try { const encrypted=provider.encrypt(plaintext.toString('utf8'),'direct-xfer-state-v2'); migrated=JSON.stringify({dxenc:2,provider:'external',keyId:encrypted.keyId,data:encrypted.ciphertext}); } finally { plaintext.fill(0); }
const dir=path.dirname(output), temp=`${output}.migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const stamp=new Date().toISOString().replace(/[:.]/g,'-'); const backup=(output===input)?`${input}.pre-external-crypto-${stamp}`:null;
try { if(backup){fs.copyFileSync(input,backup,fs.constants.COPYFILE_EXCL);try{fs.chmodSync(backup,0o600);}catch(_){}} const fd=fs.openSync(temp,'wx',0o600); try{fs.writeFileSync(fd,migrated);fs.fsyncSync(fd);}finally{fs.closeSync(fd);} fs.renameSync(temp,output);try{fs.chmodSync(output,0o600);}catch(_){} if(process.platform!=='win32'){let fd2=null;try{fd2=fs.openSync(dir,'r');fs.fsyncSync(fd2);}catch(_){}finally{if(fd2!==null)try{fs.closeSync(fd2);}catch(_){}}} }
catch(e){try{fs.unlinkSync(temp);}catch(_){} fail(`Backup migration could not be committed: ${e.message}`);}
console.log(`Migrated backup to dxenc:2: ${output}`); if(backup) console.log(`Original retained at ${backup}`);
