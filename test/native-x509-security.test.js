'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { createTlsManager } = require('../lib/server/tls-manager');
const native = require('../lib/server/native-x509-compat');

function manager(root) {
  return createTlsManager({
    fs, path, os, net, tls, crypto, forge:native, bool:(v)=>v === true || v === 'true',
    isPrivateIp:()=>true, BIND:'127.0.0.1', DATA_DIR:root, PUBLIC_HOST:'',
    PUBLIC_URL:'', LOCAL_IP:'127.0.0.1', getState:()=>({settings:{tlsLocalCa:true}}),
  });
}

test('native TLS certificates are valid, retain existing trust anchors and fail closed on CA corruption', {timeout:60000}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-native-tls-'));
  try {
    const m=manager(dir);
    const first=m.loadTlsOptions();
    assert.ok(first.key.includes('BEGIN RSA PRIVATE KEY'));
    const caPem=fs.readFileSync(m.localCaPaths().caCert,'utf8');
    const ca=new crypto.X509Certificate(caPem), leaf=new crypto.X509Certificate(first.cert);
    assert.equal(ca.ca,true);
    assert.equal(leaf.ca,false);
    assert.equal(leaf.verify(ca.publicKey),true);
    assert.equal(leaf.checkPrivateKey(crypto.createPrivateKey(first.key)),true);
    assert.match(leaf.subjectAltName,/DNS:localhost/);
    assert.match(leaf.subjectAltName,/IP Address:127\.0\.0\.1/);
    tls.createSecureContext({key:first.key,cert:first.cert,ca:caPem,minVersion:'TLSv1.2'});
    const second=manager(dir).loadTlsOptions();
    assert.equal(second.cert,first.cert,'Do not regenerate an unexpired leaf');
    assert.equal(fs.readFileSync(m.localCaPaths().caCert,'utf8'),caPem,'Do not rotate the CA trust anchor');
    fs.writeFileSync(m.localCaPaths().caCert,'not a certificate');
    assert.throws(()=>manager(dir).ensureLocalCa(),/PEM|certificate|Local CA|invalid/i,'Never silently overwrite a previously trusted CA');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('native certificate parser rejects invalid or mismatched cryptographic material', () => {
  assert.throws(()=>native.pki.certificateFromPem('invalid PEM'));
  assert.throws(()=>native.pki.privateKeyFromPem('invalid key'));
});

const { spawnSync } = require('node:child_process');
const OPENSSL_AVAILABLE = spawnSync('openssl', ['version'], {encoding:'utf8',timeout:5000}).status === 0;

test('native TLS reuses legacy multivalued-RDN CA without corrupting the issuer name', {
  skip:!OPENSSL_AVAILABLE, timeout:60000,
}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-legacy-rdn-'));
  try {
    const paths=manager(dir).localCaPaths();
    fs.mkdirSync(paths.dir,{recursive:true});
    // Real X.509 multivalued RDN: older or imported root CAs can encode CN+OU
    // within one SET. The name must be copied byte-for-byte into a new leaf.
    const req=spawnSync('openssl', [
      'req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','365',
      '-subj','/CN=Direct-Xfer Local CA+OU=Local Network/O=Direct-Xfer',
      '-addext','basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext','keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',paths.caKey,'-out',paths.caCert,
    ],{encoding:'utf8',timeout:30000});
    assert.equal(req.status,0,req.stderr);
    const oldCa=fs.readFileSync(paths.caCert,'utf8');
    const cert=manager(dir).loadTlsOptions();
    assert.ok(cert && cert.cert && cert.key);
    const decoded=native.pki.certificateFromPem(oldCa);
    assert.equal(decoded.subject.attributes.length,3,'all attributes in multi-valued RDNs must survive parsing');
    const result=spawnSync('openssl',[
      'verify','-purpose','sslserver','-CAfile',paths.caCert,paths.serverCert,
    ],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr || result.stdout);
    const ca=new crypto.X509Certificate(oldCa);
    const leaf=new crypto.X509Certificate(cert.cert);
    assert.equal(leaf.issuer,ca.subject,'issued leaf must retain the issuer distinguished name');
    assert.equal(fs.readFileSync(paths.caCert,'utf8'),oldCa,'existing trusted CA must not rotate');
    assert.equal(manager(dir).loadTlsOptions().cert,cert.cert,'valid signed leaf must not rotate on restart');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
