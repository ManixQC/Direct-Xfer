'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-historical');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'MANIFEST.json'), 'utf8'));
const commit = String(manifest.sourceCommit || '');
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('Invalid historical-test source commit');

function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(Buffer.from(`blob ${buf.length}\0`)).update(buf).digest('hex');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function get(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Direct-Xfer-test-restorer/1.67.2', Accept: 'application/octet-stream' }, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); resolve(get(new URL(res.headers.location, url), redirects - 1)); return;
      }
      if (res.statusCode !== 200) { const status=res.statusCode; res.resume(); reject(new Error(`HTTP ${status} for ${url}`)); return; }
      const chunks=[]; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
  });
}
async function fetchVerified(entry, attempts = 4) {
  const safePath = String(entry.path).split('/').map(encodeURIComponent).join('/');
  const url = `https://raw.githubusercontent.com/${manifest.repository}/${commit}/test/${safePath}`;
  let last;
  for (let n=0; n<attempts; n++) {
    try {
      const buf = await get(url);
      const sha = gitBlobSha(buf);
      if (sha !== entry.sha) throw new Error(`SHA mismatch for ${entry.path}: ${sha} != ${entry.sha}`);
      return buf;
    } catch (e) { last=e; if (n+1<attempts) await sleep(350 * (n+1)); }
  }
  throw last;
}
function existingValid(entry) {
  const file=path.join(OUT, entry.path);
  try { return gitBlobSha(fs.readFileSync(file)) === entry.sha; } catch { return false; }
}
function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temp=`${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, buf); fs.renameSync(temp, file);
}

(async () => {
  fs.mkdirSync(OUT, { recursive:true });
  const entries = Array.isArray(manifest.tests) ? manifest.tests : [];
  if (entries.length !== manifest.count) throw new Error('Historical-test manifest count mismatch');
  const bySha = new Map();
  for (const e of entries) {
    if (!/^[0-9a-f]{40}$/i.test(e.sha) || !e.path || path.basename(e.path) !== e.path) throw new Error(`Invalid manifest entry: ${JSON.stringify(e)}`);
    const list=bySha.get(e.sha)||[]; list.push(e); bySha.set(e.sha,list);
  }
  let completed=0, fetched=0, reused=0;
  const groups=[...bySha.values()];
  let cursor=0;
  async function worker() {
    while (true) {
      const idx=cursor++; if (idx>=groups.length) return;
      const group=groups[idx];
      let buf=null;
      const valid=group.find(existingValid);
      if (valid) { buf=fs.readFileSync(path.join(OUT,valid.path)); reused++; }
      else { buf=await fetchVerified(group[0]); fetched++; }
      for (const e of group) {
        const dest=path.join(OUT,e.path);
        if (!existingValid(e)) atomicWrite(dest,buf);
        if (gitBlobSha(fs.readFileSync(dest)) !== e.sha) throw new Error(`Post-write SHA mismatch: ${e.path}`);
        completed++;
      }
      if (completed % 25 === 0 || completed === entries.length) process.stdout.write(`Historical tests: ${completed}/${entries.length}\n`);
    }
  }
  await Promise.all(Array.from({length:Math.min(6,groups.length)}, worker));
  console.log(`Done: ${completed} files verified (${fetched} blobs downloaded, ${reused} existing blobs reused).`);
})().catch(err => { console.error(err && err.stack || err); process.exitCode=1; });
