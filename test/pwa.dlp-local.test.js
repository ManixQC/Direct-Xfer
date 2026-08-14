'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const archiver = require('archiver');
const DLP = require('../pwa/dlp-local.js');

function namedBlob(text, name, type='text/plain') {
  const blob = new Blob([text], { type });
  Object.defineProperty(blob, 'name', { value:name, configurable:true });
  Object.defineProperty(blob, 'lastModified', { value:1700000000000, configurable:true });
  return blob;
}
async function zipBlob(entries) {
  const out = new PassThrough(), chunks = [];
  out.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { out.on('end', resolve); out.on('error', reject); });
  const zip = new archiver.ZipArchive({ zlib:{ level:0 } });
  zip.on('error', (e) => out.destroy(e));
  zip.pipe(out);
  for (const [name, content] of Object.entries(entries)) zip.append(Buffer.from(content), { name, store:true });
  await zip.finalize(); await done;
  const blob = new Blob([Buffer.concat(chunks)], { type:'application/zip' });
  Object.defineProperty(blob, 'name', { value:'bundle.zip', configurable:true });
  return blob;
}

test('PWA local DLP mirrors high-value server detectors and redacts samples', () => {
  const text = [
    'card 4242 4242 4242 4242',
    '-----BEGIN PRIVATE KEY-----',
    'password=SuperSecret2026!',
    'strictly confidential'
  ].join('\n');
  const findings = DLP.detectFindings(text, 'secrets.env');
  const types = new Set(findings.map((f) => f.type));
  assert.ok(types.has('payment-card'));
  assert.ok(types.has('private-key'));
  assert.ok(types.has('password'));
  assert.ok(types.has('confidential-marker'));
  assert.equal(findings.some((f) => String(f.sample).includes('4242 4242 4242 4242')), false, 'full card number must never be exposed');
  assert.equal(findings.some((f) => String(f.sample).includes('SuperSecret2026!')), false, 'full password must never be exposed');
});

test('PWA local DLP scans .env and extensionless text files', async () => {
  const env = namedBlob('API_KEY=abcdefghijklmnop123456789\n', '.env', 'application/octet-stream');
  const dockerfile = namedBlob('password=anotherSecret123\n', 'Dockerfile', 'application/octet-stream');
  const a = await DLP.scanFile(env, { maxBytes:1024*1024, scanOcr:false });
  const b = await DLP.scanFile(dockerfile, { maxBytes:1024*1024, scanOcr:false });
  assert.ok(a.findings.some((f) => f.type === 'api-secret'), JSON.stringify(a));
  assert.ok(b.findings.some((f) => f.type === 'password'), JSON.stringify(b));
});

test('PWA local DLP scans text members inside ZIP archives', async () => {
  const zip = await zipBlob({
    'safe/readme.txt':'hello world',
    '.env':'client_secret=abcdefghijklmnop1234567890'
  });
  const result = await DLP.scanFile(zip, { maxBytes:5*1024*1024, scanOcr:false, maxZipEntries:20, maxZipTextBytes:1024*1024 });
  assert.ok(result.findings.some((f) => f.type === 'api-secret'), JSON.stringify(result));
});

test('PWA local DLP uses local OCR callbacks for image and PDF scans', async () => {
  let imageCalls = 0, pdfCalls = 0;
  const image = namedBlob('fake', 'scan.png', 'image/png');
  const pdf = namedBlob('%PDF fake', 'scan.pdf', 'application/pdf');
  const ir = await DLP.scanFile(image, { maxBytes:1024*1024, scanOcr:true, ocrImage:async()=>{ imageCalls++; return 'CONFIDENTIAL password=CameraSecret99'; } });
  const pr = await DLP.scanFile(pdf, { maxBytes:1024*1024, scanOcr:true, extractPdfText:async(_f, withOcr)=>{ pdfCalls++; assert.equal(withOcr,true); return 'passport AB123456'; } });
  assert.equal(imageCalls,1); assert.equal(pdfCalls,1);
  assert.ok(ir.findings.some((f) => f.type === 'confidential-marker'));
  assert.ok(pr.findings.some((f) => f.type === 'identity-document'));
});

test('PWA queue runs DLP before any upload and exposes manual tests/status', () => {
  const app = fs.readFileSync(path.join(__dirname,'..','pwa','app.js'),'utf8');
  const html = fs.readFileSync(path.join(__dirname,'..','pwa','index.html'),'utf8');
  const sw = fs.readFileSync(path.join(__dirname,'..','pwa','sw.js'),'utf8');
  const server = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(app, /async function ensurePwaDlpBeforeBatch\(candidates\)/);
  assert.match(app, /if \(!await ensurePwaDlpBeforeBatch\(candidates\)\) return;[\s\S]{0,240}confirmMobileDataIfNeeded/);
  assert.match(app, /runPwaDlpForItem\(it, \{ force:true \}\)/);
  assert.match(app, /action === 'block'[\s\S]{0,180}return false/);
  assert.match(app, /dlpApprovedFingerprint/);
  assert.match(html, /id="dlp-test-queue-btn"/);
  assert.match(html, /id="bulk-dlp-btn"/);
  assert.match(html, /id="dlp-pwa-policy"/);
  assert.match(html, /dlp-local\.js\?v=267/);
  assert.match(sw, /dlp-local\.js\?v=267/);
  assert.match(server, /function pwaDlpPolicyPayload\(req\)[\s\S]{0,2200}maxFileMB:[\s\S]{0,500}scanOcr:/);
  assert.match(server, /dlp:\s*pwaDlpPolicyPayload\(req\)/);
});

test('PWA DLP marks oversized and partially inspected archives as incomplete', async () => {
  const large = namedBlob('x'.repeat(2 * 1024 * 1024), 'large.txt', 'text/plain');
  const lr = await DLP.scanFile(large, { maxBytes:1024*1024, scanOcr:false });
  assert.equal(lr.filesSkipped, 1);
  assert.equal(lr.incomplete, true);
  assert.equal(lr.truncated, true);

  const zip = await zipBlob({
    'one.txt':'hello',
    'two.txt':'password=SecondSecret123',
    'three.txt':'hello again'
  });
  const zr = await DLP.scanFile(zip, { maxBytes:5*1024*1024, scanOcr:false, maxZipEntries:1, maxZipTextBytes:1024*1024 });
  assert.equal(zr.incomplete, true);
  assert.equal(zr.truncated, true);
  assert.ok(zr.incompleteEntries >= 1, JSON.stringify(zr));
});

test('PWA DLP never reports an encrypted text member as safe', async () => {
  const normal = await zipBlob({ 'secret.txt':'password=ArchiveSecret123' });
  const buf = Buffer.from(await normal.arrayBuffer());
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      buf.writeUInt16LE(buf.readUInt16LE(i + 8) | 1, i + 8); // mark central-dir entry encrypted
      break;
    }
  }
  const encrypted = new Blob([buf], { type:'application/zip' });
  Object.defineProperty(encrypted, 'name', { value:'encrypted.zip', configurable:true });
  const r = await DLP.scanFile(encrypted, { maxBytes:5*1024*1024, scanOcr:false });
  assert.equal(r.count, 0);
  assert.equal(r.incomplete, true);
  assert.ok(r.incompleteEntries >= 1, JSON.stringify(r));
});

test('PWA DLP propagates incomplete mixed-PDF OCR results and versions its cache engine', async () => {
  const pdf = namedBlob('%PDF fake', 'mixed.pdf', 'application/pdf');
  const r = await DLP.scanFile(pdf, {
    maxBytes:1024*1024,
    scanOcr:true,
    extractPdfText:async()=>({ text:'normal embedded text', incompletePages:2, truncated:true })
  });
  assert.equal(r.incomplete, true);
  assert.equal(r.incompleteEntries, 2);
  assert.ok(Number(DLP.version) >= 3);
});

test('PWA DLP preflight fails closed for unknown/incomplete block policy and reuses one OCR worker per batch', () => {
  const app = fs.readFileSync(path.join(__dirname,'..','pwa','app.js'),'utf8');
  assert.match(app, /mode:\s*d && \['warn','block','log','quarantine'\][\s\S]{0,160}: 'block'/);
  assert.match(app, /if \(!policy\.known\) \{ toast\(t\('dlpPolicyUnavailable'\), 'err'\); return false; \}/);
  assert.match(app, /action === 'block' && \(result\.count \|\| incomplete\)/);
  assert.match(app, /window\.DirectXferDlp && window\.DirectXferDlp\.version/);
  assert.match(app, /policy\.maxFiles, policy\.maxFileMB/);
  assert.match(app, /for \(var j = max; j < targets\.length; j\+\+\)[\s\S]{0,900}error:'max-files'/);
  assert.match(app, /keepOcrWorker:true/);
  assert.match(app, /finally \{[\s\S]{0,120}terminateOcrWorker/);
  assert.match(app, /worker\.recognize\(canvas\)/);
  assert.match(app, /incompletePages:failedPages \+ Math\.max\(0, total - limit\)/);
});
