'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_DEPLOYMENT_REQUIREMENTS, REQUIRED_METHOD, sha256Canonical, signEvidenceBundle } = require('../../lib/server/asvs-l3-evidence');

function observations() {
  return {
    'V3.7.4':{ preloaded:true, domain:'direct-xfer.example' },
    'V4.1.2':{ userFacingHttpStatus:308, userFacingLocation:'https://direct-xfer.example/', apiHttpRedirected:false },
    'V4.1.3':{ untrustedForwardedHeadersIgnored:true, trustedProxyHeadersAuthenticated:true },
    'V4.2.1':{ clTeAmbiguityRejected:true, duplicateContentLengthRejected:true, messageBoundariesConsistent:true },
    'V4.2.3':{ http2Or3ConnectionHeadersRejected:true },
    'V4.2.4':{ http2Or3CrLfHeadersRejected:true },
    'V11.7.1':{ fullMemoryEncryption:true, unauthorizedProcessIsolation:true },
    'V11.7.2':{ processingMinimized:true, reencryptedAfterUse:true },
    'V12.1.2':{ forwardSecrecyOnly:true, recommendedCipherSuitesOnly:true },
    'V12.1.4':{ revocationCheckingEnabled:true },
    'V12.1.5':{ echEnabled:true },
    'V12.2.2':{ publiclyTrustedCertificate:true, hostnameVerified:true },
    'V13.2.1':{ allEnabledBackendsAuthenticated:true, credentialsShortLivedOrRotated:true },
    'V13.2.2':{ backendIdentitiesLeastPrivilege:true },
    'V13.2.5':{ egressDefaultDeny:true, hostAllowlistSameOrNarrower:true },
    'V13.3.1':{ hardwareBacked:true, keyExportable:false, keyIsolation:true },
    'V13.3.2':{ leastPrivilege:true, keyExtractionDenied:true },
    'V13.3.3':{ allSecretKeyOperationsIsolated:true, keyMaterialNeverExported:true },
    'V15.2.1':{ dependencyScanPassed:true, containerScanPassed:true, criticalFindings:0, highFindings:0 },
    'V16.2.2':{ synchronized:true, maxOffsetMs:12 },
    'V16.4.2':{ remoteImmutable:true, retentionEnforced:true },
    'V16.4.3':{ logicallySeparate:true, transportTlsVerified:true, ingestAuthenticated:true },
  };
}

function writeFakeProvider(dir, overrides = {}) {
  const file = path.join(dir, 'fake-hsm-provider.js');
  const selfTest = {
    ok:true, operations:['encrypt','decrypt','hmac','sign'], keyIsolation:true, keyExportable:false,
    hardwareBacked:true, allSecretKeyOperationsIsolated:true,
    signingPublicKey:overrides.signingPublicKey || '', keyIds:{ data:'hsm:data', 'audit-hmac':'hsm:audit-hmac', 'audit-signing':'hsm:audit-signing', 'runtime-hmac':'hsm:runtime-hmac' },
    ...overrides,
  };
  if (!selfTest.signingPublicKey) {
    const pair = crypto.generateKeyPairSync('ed25519');
    selfTest.signingPublicKey = pair.publicKey.export({ type:'spki', format:'pem' });
    selfTest.__privateKey = pair.privateKey.export({ type:'pkcs8', format:'pem' });
  }
  const privatePem = selfTest.__privateKey || '';
  delete selfTest.__privateKey;
  const source = `#!/usr/bin/env node\n'use strict';\nconst crypto=require('crypto');\nconst req=JSON.parse(require('fs').readFileSync(0,'utf8'));\nconst dataKey=Buffer.alloc(32,11), hmacKey=Buffer.alloc(32,22);\nconst self=${JSON.stringify(selfTest)};\nconst privateKey=${JSON.stringify(privatePem)};\nlet out;\nif(req.op==='self-test') out=self;\nelse if(req.op==='encrypt'){const iv=Buffer.alloc(12,7);const c=crypto.createCipheriv('aes-256-gcm',dataKey,iv);const ct=Buffer.concat([c.update(Buffer.from(req.plaintext,'base64')),c.final()]);out={ok:true,keyId:'hsm:data',ciphertext:Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64')};}\nelse if(req.op==='decrypt'){const b=Buffer.from(req.ciphertext,'base64'),iv=b.subarray(0,12),tag=b.subarray(12,28),ct=b.subarray(28);const d=crypto.createDecipheriv('aes-256-gcm',dataKey,iv);d.setAuthTag(tag);out={ok:true,plaintext:Buffer.concat([d.update(ct),d.final()]).toString('base64')};}\nelse if(req.op==='hmac') out={ok:true,digest:crypto.createHmac('sha256',hmacKey).update(Buffer.from(req.input,'base64')).digest('hex')};\nelse if(req.op==='sign') out={ok:true,signature:crypto.sign(null,Buffer.from(req.input,'base64'),privateKey).toString('base64')};\nelse out={ok:false,error:'unsupported'};\nprocess.stdout.write(JSON.stringify(out));\n`;
  fs.writeFileSync(file, source, { mode:0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function writeEvidence(dir, options = {}) {
  const now = options.now || Date.now();
  const keyPair = options.keyPair || crypto.generateKeyPairSync('ed25519');
  const obs = observations();
  const checks = REQUIRED_DEPLOYMENT_REQUIREMENTS.map((id) => ({
    id, status:'pass', method:REQUIRED_METHOD[id], observedAt:now - 1000,
    observation:obs[id], digest:sha256Canonical(obs[id]),
  }));
  let bundle = {
    evidenceVersion:1, profile:'OWASP-ASVS-5.0.0-L3', release:options.release || '1.71.20',
    publicOrigin:options.publicOrigin || 'https://direct-xfer.example', generatedAt:now - 2000,
    expiresAt:now + 24*60*60*1000, checks,
  };
  bundle = signEvidenceBundle(bundle, keyPair.privateKey.export({ type:'pkcs8', format:'pem' }));
  const file = path.join(dir, 'asvs-l3-evidence.json');
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
  return { file, bundle, publicKey:keyPair.publicKey.export({ type:'spki', format:'pem' }), keyPair };
}

function completeL3Config(dir, overrides = {}) {
  const provider = writeFakeProvider(dir);
  const evidence = writeEvidence(dir);
  return {
    ASVS_L3_MODE:true, APP_VERSION:'1.71.20', PUBLIC_URL:'https://direct-xfer.example',
    DATA_KEY:'', AUDIT_HMAC_KEY:'', AUDIT_SIGNING_PRIVATE_KEY:'', AUDIT_SIGNING_PRIVATE_KEY_FILE:'',
    CLAMAV_SOCKET:'/run/clamd.sock', CLAMAV_HOST:'', CLAMAV_PORT:3310, CLAMAV_TLS:false,
    AUDIT_REMOTE_URL:'https://siem.example/ingest', ASVS_L3_EGRESS_ALLOWLIST:'siem.example,oauth2.googleapis.com',
    ASVS_L3_CRYPTO_PROVIDER:'hsm', ASVS_L3_CRYPTO_COMMAND:provider,
    ASVS_L3_EVIDENCE_FILE:evidence.file, ASVS_L3_EVIDENCE_PUBLIC_KEY:evidence.publicKey,
    ASVS_L3_HARDWARE_AAGUIDS:'00112233445566778899aabbccddeeff',
    ASVS_L3_ATTESTATION_ROOT_SHA256:'a'.repeat(64), ASVS_L3_ATTESTATION_ROOT_FILES:path.join(dir,'attestation-root.pem'), TRUST_PROXY:'127.0.0.1/32', ADMIN_ALLOW_ANY:false,
    ...overrides,
  };
}

module.exports = { observations, writeFakeProvider, writeEvidence, completeL3Config };
