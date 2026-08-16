'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=(...p)=>fs.readFileSync(path.join(root,...p),'utf8');

test('Local CA implementation hardens X.509 profile, durability, hot rotation and trust-anchor changes',()=>{
  const s=read('server.js');
  assert.match(s,/generateForgeRsaKeyPair\(3072\)/,'root CA is generated with RSA-3072');
  assert.match(s,/pathLenConstraint:0/,'root cannot create subordinate CAs');
  assert.match(s,/keyCertSign:true/);
  assert.match(s,/authorityKeyIdentifier/,'leaf carries AKI');
  assert.match(s,/TLS_LEAF_VALIDITY_MS = 90 \* TLS_DAY_MS/);
  assert.match(s,/TLS_LEAF_RENEW_MS = 14 \* TLS_DAY_MS/);
  assert.match(s,/exactSetEquals\(identities\.dns/,'stale SAN supersets are rejected');
  assert.match(s,/function canonicalCertificateIp\(ip\)/,'IPv6 SAN identities are canonicalized to avoid rotation churn');
  assert.match(s,/server\.setSecureContext/,'leaf can rotate without dropping the listener');
  assert.match(s,/activeTlsCaFingerprint/,'active trust anchor is pinned for the server lifetime');
  assert.match(s,/\['local-ca','local-ca-degraded'\]\.includes\(ACTIVE_TLS_MODE\)/,'degraded Local CA mode can recover signing without a restart when the same root key returns');
  assert.match(s,/trust anchor changed on disk; restart required/,'root replacement is not hot-swapped');
  assert.match(s,/\.local-ca-generation-pending/,'two-file CA creation is crash-recoverable');
  assert.match(s,/fs\.fsyncSync/,'managed TLS files are durably flushed before publication');
  assert.match(s,/readManagedTlsFile/);
  assert.match(s,/isSymbolicLink\(\)/,'managed TLS symlinks are rejected');
  assert.match(s,/RSA key is weaker than 2048 bits/);
  assert.match(s,/unsupported or weak signature algorithm/);
});

test('TLS policy and bootstrap avoid downgrade/persistent-HSTS traps and credential exposure',()=>{
  const s=read('server.js');
  const html=read('public','index.html');
  assert.match(s,/minVersion:'TLSv1\.2'/);
  assert.match(s,/localCaModeActive\(\) \? 'max-age=0' : 'max-age=31536000'/,'Local CA mode actively clears stale HSTS');
  assert.match(s,/function nativeTlsRequest\(req\)/);
  assert.match(s,/app\.get\('\/direct-xfer-local-ca\.cer', sendLocalCaCertificate\)/,'root can be bootstrapped without admin credentials');
  assert.match(s,/local-ca-download-requires-local-or-https/,'remote plaintext bootstrap is rejected');
  assert.match(s,/X-Direct-Xfer-CA-SHA256/);
  assert.match(html,/href="\/direct-xfer-local-ca\.cer"/);
});

test('full backup/restore preserves a Local CA only inside an encrypted v3 backup',()=>{
  const s=read('server.js');
  assert.match(s,/kind:\s*'dxbackup',\s*v:\s*3/);
  assert.match(s,/if \(!DATA_KEY \|\| !forge\) return null/,'plaintext backup never exports trust-anchor material');
  assert.match(s,/localCaKey/);
  assert.match(s,/restore-tls-requires-encrypted-backup/,'crafted plaintext backups cannot inject a trust anchor');
  assert.match(s,/tlsCertificateRestartRequired = true/,'restored CA is activated only on restart');
  assert.match(s,/omitting invalid Local CA server certificate/,'disposable leaf corruption does not destroy CA backupability');
  assert.match(s,/recoverInterruptedTlsRestore/,'TLS restore has crash recovery');
  assert.match(s,/tlsRestoreCommitId/,'TLS restore transaction is linked to the durable store commit');
});

test('Windows launcher keeps private loopback control channel compatible with managed HTTPS',()=>{
  const s=read('windows-launcher','Program.cs');
  assert.match(s,/RuntimeAppBuild = "1\.62\.4-launcher45-csharp"/);
  assert.match(s,/ServerCertificateValidationCallback/);
  assert.match(s,/127\.0\.0\.1/);
  assert.match(s,/X-Direct-Xfer-Launcher-Token/);
  assert.match(s,/expectedPid/,'readiness is tied to the spawned Node PID');
});
