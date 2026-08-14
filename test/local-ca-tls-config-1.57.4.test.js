'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const forge = require('node-forge');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((e) => e ? reject(e) : resolve(p));
    });
  });
}

function requestPath(scheme, port, ca, reqPath='/healthz', tlsOptions={}) {
  const mod = scheme === 'https' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get({
      hostname:'127.0.0.1', port, path:reqPath,
      ...(scheme === 'https' ? { ca, rejectUnauthorized:true, ...tlsOptions } : {}),
    }, (res) => {
      const chunks=[]; res.on('data',(c)=>{chunks.push(Buffer.from(c));}); res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
  });
}
function requestHealth(scheme, port, ca, tlsOptions={}) {
  return requestPath(scheme, port, ca, '/healthz', tlsOptions).then((r) => ({...r, body:r.body.toString('utf8')}));
}

async function waitForFile(file, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before TLS files were ready: ' + child.exitCode);
    if (fs.existsSync(file)) return;
    await new Promise((r)=>setTimeout(r,100));
  }
  throw new Error('TLS file timeout');
}

async function waitHealth(scheme, port, child, ca) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before readiness: ' + child.exitCode);
    try { const r = await requestHealth(scheme, port, ca); if (r.status === 200) return r; } catch (_) {}
    await new Promise((r)=>setTimeout(r,100));
  }
  throw new Error('server readiness timeout');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve)=>child.once('exit',resolve)),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('shutdown timeout')),12000)),
  ]);
}

function startServer(dataDir, dirs, port, extraEnv={}) {
  return spawn(process.execPath, ['server.js'], {
    cwd:root, stdio:'ignore',
    env:{
      ...process.env, PORT:String(port), BIND:'127.0.0.1', DATA_DIR:dataDir,
      HOST_ROOT:dirs.host, INBOX_DIR:dirs.inbox, IMAGES_DIR:dirs.images,
      ADMIN_PASSWORD:'LocalCaConfigTest-123!', UPDATE_CHECK:'0', NO_COLOR:'1',
      LOCAL_IP:'192.168.55.10', PUBLIC_URL:'https://[fd00:0:0:0::1234]:55750', ...extraEnv,
    },
  });
}

test('1.59.1 exposes Local CA LAN HTTPS configuration, fingerprint and root download in FR/EN/ES', () => {
  const server = read('server.js');
  const html = read('public','index.html');
  const app = read('public','app.js');
  assert.match(server, /tlsLocalCa:\s*false/);
  assert.match(server, /typeof body\.tlsLocalCa === 'boolean'/);
  assert.match(server, /Direct-Xfer Local CA/);
  assert.match(server, /adminRouter\.get\('\/tls\/local-ca\.cer'/);
  assert.match(server, /X-Direct-Xfer-CA-SHA256/);
  assert.match(server, /normalizeLanCertificateIp/);
  assert.match(server, /function isLanCertificateHostname\(name\)/);
  assert.match(html, /id="cfg-tls-localca"/);
  assert.match(html, /id="cfg-tls-ca-fingerprint"/);
  assert.match(html, /href="\/direct-xfer-local-ca\.cer"/);
  assert.match(app, /autorité locale Direct-Xfer \(LAN uniquement\)/);
  assert.match(app, /Direct-Xfer Local CA \(LAN only\)/);
  assert.match(app, /CA local de Direct-Xfer \(solo LAN\)/);
  assert.match(app, /payload\.tlsLocalCa = \$\('cfg-tls-localca'\)\.checked/);
});

test('Windows portable launcher keeps authenticated HTTP/HTTPS probing for Local CA mode', () => {
  const launcher = read('windows-launcher','Program.cs');
  assert.match(launcher, /ServerCertificateValidationCallback/);
  assert.match(launcher, /ValidateLauncherServerCertificate/);
  assert.match(launcher, /RemoteCertificateNameMismatch/);
  assert.match(launcher, /AllowUnknownCertificateAuthority/);
  assert.match(launcher, /local-ca-cert\.pem/);
  assert.match(launcher, /SchemeCandidates/);
  assert.match(launcher, /127\.0\.0\.1/);
  assert.match(launcher, /X-Direct-Xfer-Launcher-Token/);
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.1-launcher27-csharp"/);
});

test('Local CA mode starts trusted HTTPS, reuses CA, signs LAN identities and env false overrides it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'dx-localca-1574-'));
  const data = path.join(tmp,'data');
  const dirs = {host:path.join(tmp,'host'),inbox:path.join(tmp,'inbox'),images:path.join(tmp,'images')};
  fs.mkdirSync(data,{recursive:true}); for (const d of Object.values(dirs)) fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(data,'shares.json'), JSON.stringify({version:1,shares:[],settings:{tlsLocalCa:true}}));
  // Simulate a power loss between the two files of the very first CA creation.
  // The transaction marker must make this recoverable instead of bricking HTTPS.
  const tlsDir=path.join(data,'tls'); fs.mkdirSync(tlsDir,{recursive:true});
  fs.writeFileSync(path.join(tlsDir,'.local-ca-generation-pending'),'interrupted\n');
  fs.writeFileSync(path.join(tlsDir,'local-ca-key.pem'),'partial-key');

  const p1=await freePort(); const c1=startServer(data,dirs,p1);
  try {
    const caFile=path.join(data,'tls','local-ca-cert.pem');
    await waitForFile(caFile,c1);
    const caPem=fs.readFileSync(caFile);
    const h1=await waitHealth('https',p1,c1,caPem);
    assert.equal(JSON.parse(h1.body).version,'1.59.1');
    const caKey=path.join(data,'tls','local-ca-key.pem');
    const leafFile=path.join(data,'tls','server-cert.pem');
    const leafKey=path.join(data,'tls','server-key.pem');
    for (const f of [caFile,caKey,leafFile,leafKey]) assert.ok(fs.existsSync(f),f+' must exist');
    assert.equal(fs.existsSync(path.join(data,'tls','.local-ca-generation-pending')),false,'generation marker must be cleared after committed CA creation');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(data,'tls')).mode & 0o777,0o700,'TLS directory must be private');
      assert.equal(fs.statSync(caKey).mode & 0o777,0o600,'CA key must be private');
      assert.equal(fs.statSync(leafKey).mode & 0o777,0o600,'server key must be private');
    }

    const ca1=fs.readFileSync(caFile);
    const caHash1=crypto.createHash('sha256').update(ca1).digest('hex');
    const caX=new crypto.X509Certificate(ca1);
    const leafRaw=fs.readFileSync(leafFile);
    const leafX=new crypto.X509Certificate(leafRaw);
    assert.match(caX.subject,/CN=Direct-Xfer Local CA/);
    assert.equal(leafX.issuer,caX.subject);
    assert.match(leafX.subjectAltName || '',/IP Address:192\.168\.55\.10/);
    assert.ok(leafX.checkIP('fd00::1234'),'bracketed/non-canonical PUBLIC_URL IPv6 must become a semantically correct LAN SAN');
    assert.match(leafX.subjectAltName || '',/DNS:localhost/);
    const caForge=forge.pki.certificateFromPem(ca1.toString());
    const leafForge=forge.pki.certificateFromPem(leafRaw.toString());
    assert.equal(caForge.verify(leafForge),true,'server leaf must be signed by Direct-Xfer Local CA');
    assert.ok((caX.publicKey.asymmetricKeyDetails?.modulusLength || 0) >= 3072,'new Local CA must use RSA >= 3072');
    assert.ok((leafX.publicKey.asymmetricKeyDetails?.modulusLength || 0) >= 2048,'leaf must use RSA >= 2048');
    const caBc=caForge.getExtension('basicConstraints');
    assert.equal(caForge.signatureOid,forge.pki.oids.sha256WithRSAEncryption);
    assert.equal(leafForge.signatureOid,forge.pki.oids.sha256WithRSAEncryption);
    assert.equal(caBc.cA,true); assert.equal(Number(caBc.pathLenConstraint),0); assert.equal(caBc.critical,true);
    assert.equal(leafForge.getExtension('authorityKeyIdentifier') != null,true,'leaf must carry authorityKeyIdentifier');
    assert.ok(leafForge.getExtension('extKeyUsage')?.serverAuth,'leaf must be serverAuth-only capable');
    assert.ok(leafX.validTo && (Date.parse(leafX.validTo)-Date.now()) <= 91*86400000,'leaf lifetime must be short');
    assert.equal(h1.headers['strict-transport-security'],'max-age=0','managed Local CA must clear stale HSTS state');

    const rootDownload=await requestPath('https',p1,caPem,'/direct-xfer-local-ca.cer');
    assert.equal(rootDownload.status,200,'public CA bootstrap should not require admin credentials over native HTTPS');
    assert.equal(rootDownload.headers['cache-control'],'no-store');
    const downloadedRoot=new crypto.X509Certificate(rootDownload.body);
    assert.equal(downloadedRoot.fingerprint256,caX.fingerprint256,'downloaded root must be the active Local CA');

    // A pending/corrupt on-disk CA must never be served through a listener that
    // is still presenting the previous trusted root. The bootstrap endpoint is
    // pinned to the trust anchor actually active in memory until restart.
    fs.writeFileSync(caFile,'pending-or-corrupt-ca');
    const pinnedRoot=await requestPath('https',p1,caPem,'/direct-xfer-local-ca.cer');
    assert.equal(pinnedRoot.status,200);
    assert.equal(new crypto.X509Certificate(pinnedRoot.body).fingerprint256,caX.fingerprint256,'bootstrap must stay pinned to the active TLS trust anchor');
    fs.writeFileSync(caFile,ca1);

    await assert.rejects(
      requestHealth('https',p1,caPem,{minVersion:'TLSv1',maxVersion:'TLSv1.1'}),
      /tls|protocol|socket|handshake|alert/i,
      'TLS 1.0/1.1 must be rejected'
    );
    const leafHash1=crypto.createHash('sha256').update(leafRaw).digest('hex');
    await stop(c1);

    const pSame=await freePort(); const cSame=startServer(data,dirs,pSame);
    try {
      await waitHealth('https',pSame,cSame,ca1);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(leafFile)).digest('hex'),leafHash1,'unchanged LAN identities must reuse the existing leaf instead of rotating on every restart');
    } finally { await stop(cSame); }

    // Removing a LAN IP from configuration must remove it from SANs rather than
    // keeping a stale superset forever. The trust root must remain unchanged.
    const p2=await freePort(); const c2=startServer(data,dirs,p2,{LOCAL_IP:''});
    try {
      await waitHealth('https',p2,c2,ca1);
      const caHash2=crypto.createHash('sha256').update(fs.readFileSync(caFile)).digest('hex');
      assert.equal(caHash2,caHash1,'trusted root CA must remain stable across restarts');
      const leaf2Raw=fs.readFileSync(leafFile);
      const leaf2=new crypto.X509Certificate(leaf2Raw);
      assert.doesNotMatch(leaf2.subjectAltName || '',/192\.168\.55\.10/,'removed LAN IP must not remain in SAN');
      assert.notEqual(crypto.createHash('sha256').update(leaf2Raw).digest('hex'),leafHash1,'SAN change must issue a new leaf');
    } finally { await stop(c2); }

    // Losing the CA signing key must not immediately brick HTTPS while a valid
    // leaf still exists. It should run in degraded mode until the key is restored.
    fs.unlinkSync(caKey);
    const p3=await freePort(); const c3=startServer(data,dirs,p3,{LOCAL_IP:''});
    try {
      const h3=await waitHealth('https',p3,c3,ca1);
      assert.equal(h3.status,200);
    } finally { await stop(c3); }

    // An explicit environment disable remains authoritative even if managed CA
    // files exist (or the signing key is unavailable).
    const p4=await freePort(); const c4=startServer(data,dirs,p4,{TLS_SELF_SIGNED:'false',LOCAL_IP:''});
    try { const h4=await waitHealth('http',p4,c4); assert.equal(h4.status,200); }
    finally { await stop(c4); }
  } finally {
    await stop(c1).catch(()=>{});
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
