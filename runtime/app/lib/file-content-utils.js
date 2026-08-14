'use strict';

const fs = require('fs');

async function readZipEntries(absPath, maxEntries = 2000) {
  let fh;
  try {
    fh = await fs.promises.open(absPath, 'r');
    const st = await fh.stat();
    const size = st.size;
    if (size < 22) return null;
    // EOCD is in the last 64KB (comment can push it up, but never beyond 65557 B).
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) return null; // ZIP64 not supported by this lightweight parser
    // Cap the central-directory read: a crafted/corrupt EOCD can declare a bogus
    // 4 GB cdSize, and Buffer.alloc(cdSize) would try to grab it all. 16 MB holds
    // tens of thousands of entries — far past the maxEntries we actually list.
    const allocSize = Math.min(cdSize, Math.max(0, size - cdOffset), 16 * 1024 * 1024);
    if (allocSize <= 0) return null;
    const cd = Buffer.alloc(allocSize);
    await fh.read(cd, 0, allocSize, cdOffset);
    const entries = [];
    let p = 0, truncated = false;
    for (let n = 0; n < total && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const uncomp = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const dir = name.endsWith('/');
      if (entries.length < maxEntries) entries.push({ name, size: dir ? 0 : uncomp, dir });
      else { truncated = true; }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, truncated, count: total };
  } catch (_) {
    return null;
  } finally {
    if (fh) try { await fh.close(); } catch (_) {}
  }
}

// Reads at most maxBytes from a file WITHOUT loading the whole thing into memory.
// Shared host files can be arbitrarily large, so the text-preview features must
// never `readFile()` them whole. Returns { buf, truncated }.
async function readFileCapped(abs, maxBytes) {
  let fh;
  try {
    fh = await fs.promises.open(abs, 'r');
    const size = (await fh.stat()).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return { buf: off === want ? buf : buf.subarray(0, off), truncated: size > maxBytes };
  } finally {
    if (fh) try { await fh.close(); } catch (_) {}
  }
}


module.exports = { readZipEntries, readFileCapped };
