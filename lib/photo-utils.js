'use strict';

const fs = require('fs');

function previewInfo(filename) {
  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  const images = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
  const videos = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska' };
  const audios = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac' };
  const texts = ['txt', 'md', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'js', 'mjs', 'cjs', 'ts', 'css', 'py', 'sh', 'bash', 'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'toml'];
  if (images[ext]) return { kind: 'image', contentType: images[ext] };
  if (videos[ext]) return { kind: 'video', contentType: videos[ext] };
  if (audios[ext]) return { kind: 'audio', contentType: audios[ext] };
  if (ext === 'pdf') return { kind: 'pdf', contentType: 'application/pdf' };
  if (texts.includes(ext)) return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  return null;
}

// Photos tab helpers. An image content type (or null if the file isn't a
// supported image), and a clean lowercase extension for the direct /i/<token>.ext
// URL (jpeg → jpg; unknown → jpg).
function imageContentType(filename) {
  const info = previewInfo(filename);
  return info && info.kind === 'image' ? info.contentType : null;
}
function photoExt(s) {
  const e = (String((s && s.name) || '').split('.').pop() || '').toLowerCase();
  if (e === 'jpeg') return 'jpg';
  return /^(jpg|png|gif|webp|bmp|avif)$/.test(e) ? e : 'jpg';
}

// Reads pixel dimensions from an image file's header — no image library needed.
// Supports PNG, JPEG, GIF, WEBP and BMP; returns { w, h } or null (e.g. AVIF).
function imageDimensions(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 24) return null;
    const b = buf.subarray(0, n);
    // PNG: 8-byte signature, then IHDR width/height (big-endian uint32) at 16/20.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    // GIF: "GIF8", logical screen width/height (little-endian uint16) at 6/8.
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
      return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    }
    // BMP: "BM", 32-bit width/height at 18/22 (height may be stored negative).
    if (b[0] === 0x42 && b[1] === 0x4d) {
      return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
    }
    // WEBP: "RIFF"...."WEBP" then a VP8 / VP8L / VP8X chunk.
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8 ' && n >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L' && n >= 25) {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X' && n >= 30) {
        return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
      return null;
    }
    // JPEG: walk the segment markers to a Start-Of-Frame; dims are big-endian at +5/+7.
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 9 < n) {
        if (b[o] !== 0xff) { o++; continue; }
        let marker = b[o + 1];
        while (marker === 0xff && o + 1 < n) { o++; marker = b[o + 1]; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
        }
        const len = b.readUInt16BE(o + 2);
        if (len < 2) return null;
        o += 2 + len;
      }
      return null;
    }
    return null;
  } catch (_) { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}

// Reads a privacy-conscious subset of EXIF/GPS metadata without an image library.
// The parser is deliberately bounded and defensive: only TIFF data embedded in
// JPEG APP1, PNG eXIf or WEBP EXIF chunks is inspected, and malformed offsets are
// ignored instead of escaping the file buffer.
function parseExifTiff(tiff) {
  if (!Buffer.isBuffer(tiff) || tiff.length < 8) return null;
  const little = tiff.toString('ascii', 0, 2) === 'II';
  const big = tiff.toString('ascii', 0, 2) === 'MM';
  if (!little && !big) return null;
  const u16 = (o) => {
    if (o < 0 || o + 2 > tiff.length) return null;
    return little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
  };
  const i32 = (o) => {
    if (o < 0 || o + 4 > tiff.length) return null;
    return little ? tiff.readInt32LE(o) : tiff.readInt32BE(o);
  };
  const u32 = (o) => {
    if (o < 0 || o + 4 > tiff.length) return null;
    return little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);
  };
  if (u16(2) !== 42) return null;

  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const groups = { root: {}, exif: {}, gps: {} };
  const seen = new Set();

  function readValue(entry, type, count) {
    const unit = typeSize[type];
    if (!unit || !Number.isFinite(count) || count < 0 || count > 4096) return null;
    const bytes = unit * count;
    const valueOffset = bytes <= 4 ? entry + 8 : u32(entry + 8);
    if (valueOffset === null || valueOffset < 0 || valueOffset + bytes > tiff.length) return null;
    if (type === 2) return tiff.toString('utf8', valueOffset, valueOffset + bytes).replace(/\0+$/g, '').trim();
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const o = valueOffset + i * unit;
      let value = null;
      if (type === 1 || type === 7) value = tiff[o];
      else if (type === 3) value = u16(o);
      else if (type === 4) value = u32(o);
      else if (type === 9) value = i32(o);
      else if (type === 5 || type === 10) {
        const n = type === 10 ? i32(o) : u32(o);
        const d = type === 10 ? i32(o + 4) : u32(o + 4);
        value = n === null || d === null || d === 0 ? null : n / d;
      }
      out.push(value);
    }
    return count === 1 ? out[0] : out;
  }

  function readIfd(offset, groupName, depth) {
    if (!Number.isFinite(offset) || offset < 8 || offset + 2 > tiff.length || depth > 4) return;
    const key = groupName + ':' + offset;
    if (seen.has(key)) return;
    seen.add(key);
    const count = u16(offset);
    if (count === null || count > 512 || offset + 2 + count * 12 > tiff.length) return;
    const group = groups[groupName];
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      const tag = u16(entry), type = u16(entry + 2), valueCount = u32(entry + 4);
      if (tag === null || type === null || valueCount === null) continue;
      const value = readValue(entry, type, valueCount);
      group[tag] = value;
      if (groupName === 'root' && tag === 0x8769 && Number.isFinite(value)) readIfd(value, 'exif', depth + 1);
      if (groupName === 'root' && tag === 0x8825 && Number.isFinite(value)) readIfd(value, 'gps', depth + 1);
    }
  }

  readIfd(u32(4), 'root', 0);
  const root = groups.root, exif = groups.exif, gps = groups.gps;
  const str = (value) => typeof value === 'string' && value ? value : null;
  const num = (value) => Number.isFinite(value) ? value : null;
  const first = (value) => Array.isArray(value) ? value[0] : value;
  const coord = (parts, ref) => {
    if (!Array.isArray(parts) || parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
    let value = parts[0] + parts[1] / 60 + parts[2] / 3600;
    if (/^[SW]$/i.test(String(ref || ''))) value *= -1;
    return Number(value.toFixed(7));
  };
  const lat = coord(gps[0x0002], first(gps[0x0001]));
  const lon = coord(gps[0x0004], first(gps[0x0003]));
  let altitude = num(gps[0x0006]);
  if (altitude !== null && Number(first(gps[0x0005])) === 1) altitude *= -1;
  const gpsTime = Array.isArray(gps[0x0007]) && gps[0x0007].length >= 3
    ? gps[0x0007].slice(0, 3).map((v) => Number.isFinite(v) ? String(Math.floor(v)).padStart(2, '0') : '00').join(':')
    : null;
  const gpsDate = str(gps[0x001d]);

  const result = {
    camera: {
      make: str(root[0x010f]), model: str(root[0x0110]), lensMake: str(exif[0xa433]),
      lensModel: str(exif[0xa434]), software: str(root[0x0131]),
    },
    capture: {
      dateTimeOriginal: str(exif[0x9003]) || str(exif[0x9004]) || str(root[0x0132]),
      exposureTime: num(exif[0x829a]), fNumber: num(exif[0x829d]), iso: num(first(exif[0x8827])),
      focalLength: num(exif[0x920a]), focalLength35mm: num(exif[0xa405]),
      exposureBias: num(exif[0x9204]), flash: num(exif[0x9209]), orientation: num(root[0x0112]),
      width: num(exif[0xa002]), height: num(exif[0xa003]), whiteBalance: num(exif[0xa403]),
      exposureMode: num(exif[0xa402]), sceneType: num(exif[0xa406]),
      description: str(root[0x010e]), artist: str(root[0x013b]), copyright: str(root[0x8298]),
    },
    gps: lat !== null && lon !== null ? {
      latitude: lat, longitude: lon, altitude: altitude === null ? null : Number(altitude.toFixed(2)),
      direction: num(gps[0x0011]), directionRef: str(gps[0x0010]),
      dateTimeUtc: gpsDate ? gpsDate.replace(/:/g, '-') + (gpsTime ? ' ' + gpsTime + ' UTC' : '') : gpsTime,
    } : null,
  };
  const hasCamera = Object.values(result.camera).some((v) => v !== null);
  const hasCapture = Object.values(result.capture).some((v) => v !== null);
  return hasCamera || hasCapture || result.gps ? result : null;
}

function readPhotoMetadata(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const max = Math.min(stat.size, 4 * 1024 * 1024);
    if (max < 8) return { found: false, format: null, camera: {}, capture: {}, gps: null };
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    const b = buf.subarray(0, n);
    let tiff = null, format = null;

    if (b[0] === 0xff && b[1] === 0xd8) {
      format = 'JPEG';
      let o = 2;
      while (o + 4 <= b.length) {
        if (b[o] !== 0xff) { o += 1; continue; }
        const marker = b[o + 1];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
        const len = b.readUInt16BE(o + 2);
        if (len < 2 || o + 2 + len > b.length) break;
        const start = o + 4, end = o + 2 + len;
        if (marker === 0xe1 && end - start >= 6 && b.toString('ascii', start, start + 6) === 'Exif\0\0') {
          tiff = b.subarray(start + 6, end); break;
        }
        o += 2 + len;
      }
    } else if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      format = 'WEBP';
      let o = 12;
      while (o + 8 <= b.length) {
        const kind = b.toString('ascii', o, o + 4);
        const size = b.readUInt32LE(o + 4);
        const start = o + 8, end = start + size;
        if (end > b.length) break;
        if (kind === 'EXIF') {
          tiff = b.subarray(start, end);
          if (tiff.length >= 6 && tiff.toString('ascii', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
          break;
        }
        o = end + (size % 2);
      }
    } else if (b.length >= 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
      format = 'PNG';
      let o = 8;
      while (o + 12 <= b.length) {
        const size = b.readUInt32BE(o);
        const kind = b.toString('ascii', o + 4, o + 8);
        const start = o + 8, end = start + size;
        if (end + 4 > b.length) break;
        if (kind === 'eXIf') { tiff = b.subarray(start, end); break; }
        o = end + 4;
      }
    } else if (b.toString('ascii', 0, 2) === 'II' || b.toString('ascii', 0, 2) === 'MM') {
      format = 'TIFF'; tiff = b;
    }

    const parsed = tiff ? parseExifTiff(tiff) : null;
    return parsed
      ? { found: true, format, camera: parsed.camera, capture: parsed.capture, gps: parsed.gps }
      : { found: false, format, camera: {}, capture: {}, gps: null };
  } catch (_) {
    return { found: false, format: null, camera: {}, capture: {}, gps: null };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}



// Remove user-originated image metadata without decoding/re-encoding the pixels.
// L3 upload paths call this before persisting the final content hash. The parser
// is deliberately structural and bounded by the upload-size limit enforced by
// the caller. JPEG/PNG/WebP/GIF are sanitized losslessly; BMP/AVIF require an
// explicit metadata-retention consent because safely rewriting all metadata
// containers without a decoder would risk corrupting legitimate pixel data.
async function sanitizeImageMetadataFile(filePath, extension) {
  const ext = String(extension || '').toLowerCase().replace(/^jpeg$/, 'jpg');
  const source = await fs.promises.readFile(filePath);
  let output = null;

  if (ext === 'jpg') {
    if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) throw Object.assign(new Error('invalid-jpeg'), { code:'invalid-image-content' });
    const chunks = [source.subarray(0, 2)];
    let o = 2;
    while (o < source.length) {
      if (source[o] !== 0xff) throw Object.assign(new Error('invalid-jpeg-marker'), { code:'invalid-image-content' });
      let markerPos = o;
      while (o < source.length && source[o] === 0xff) o += 1;
      if (o >= source.length) throw Object.assign(new Error('invalid-jpeg-marker'), { code:'invalid-image-content' });
      const marker = source[o];
      o += 1;
      if (marker === 0xd9) { chunks.push(source.subarray(markerPos, o)); break; }
      if (marker === 0xda) { // Start of Scan: metadata segments are all before entropy-coded image data.
        chunks.push(source.subarray(markerPos));
        o = source.length;
        break;
      }
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        chunks.push(source.subarray(markerPos, o));
        continue;
      }
      if (o + 2 > source.length) throw Object.assign(new Error('invalid-jpeg-segment'), { code:'invalid-image-content' });
      const len = source.readUInt16BE(o);
      if (len < 2 || o + len > source.length) throw Object.assign(new Error('invalid-jpeg-segment'), { code:'invalid-image-content' });
      const end = o + len;
      // APP1 carries EXIF/XMP, APP13 commonly IPTC/Photoshop metadata, and COM
      // carries free-form user data. Pixel/color-critical APP0/APP2/APP14 remain.
      if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) chunks.push(source.subarray(markerPos, end));
      o = end;
    }
    output = Buffer.concat(chunks);
  } else if (ext === 'png') {
    const signature = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    if (source.length < 20 || !source.subarray(0,8).equals(signature)) throw Object.assign(new Error('invalid-png'), { code:'invalid-image-content' });
    const chunks = [source.subarray(0,8)];
    const sensitive = new Set(['eXIf','tEXt','zTXt','iTXt','tIME']);
    let o = 8, ended = false;
    while (o + 12 <= source.length) {
      const len = source.readUInt32BE(o);
      const end = o + 12 + len;
      if (len > source.length || end > source.length) throw Object.assign(new Error('invalid-png-chunk'), { code:'invalid-image-content' });
      const kind = source.toString('ascii', o + 4, o + 8);
      if (!sensitive.has(kind)) chunks.push(source.subarray(o, end));
      o = end;
      if (kind === 'IEND') { ended = true; break; }
    }
    if (!ended) throw Object.assign(new Error('invalid-png-end'), { code:'invalid-image-content' });
    output = Buffer.concat(chunks);
  } else if (ext === 'webp') {
    if (source.length < 20 || source.toString('ascii',0,4) !== 'RIFF' || source.toString('ascii',8,12) !== 'WEBP') throw Object.assign(new Error('invalid-webp'), { code:'invalid-image-content' });
    const chunks = [Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')];
    let o = 12;
    while (o + 8 <= source.length) {
      const kind = source.toString('ascii', o, o + 4);
      const len = source.readUInt32LE(o + 4);
      const dataStart = o + 8, dataEnd = dataStart + len, paddedEnd = dataEnd + (len & 1);
      if (dataEnd > source.length || paddedEnd > source.length) throw Object.assign(new Error('invalid-webp-chunk'), { code:'invalid-image-content' });
      if (kind !== 'EXIF' && kind !== 'XMP ') {
        const chunk = Buffer.from(source.subarray(o, paddedEnd));
        if (kind === 'VP8X' && len >= 1) chunk[8] &= ~0x0c; // clear EXIF + XMP feature flags
        chunks.push(chunk);
      }
      o = paddedEnd;
    }
    output = Buffer.concat(chunks);
    output.writeUInt32LE(output.length - 8, 4);
  } else if (ext === 'gif') {
    if (source.length < 14 || !/^GIF8[79]a$/.test(source.toString('ascii',0,6))) throw Object.assign(new Error('invalid-gif'), { code:'invalid-image-content' });
    const chunks = [source.subarray(0,13)];
    let o = 13;
    const packed = source[10];
    if (packed & 0x80) {
      const size = 3 * (1 << ((packed & 0x07) + 1));
      if (o + size > source.length) throw Object.assign(new Error('invalid-gif-table'), { code:'invalid-image-content' });
      chunks.push(source.subarray(o,o+size)); o += size;
    }
    const consumeBlocks = (start) => {
      let i = start;
      while (i < source.length) {
        const n = source[i]; i += 1;
        if (n === 0) return i;
        if (i + n > source.length) throw Object.assign(new Error('invalid-gif-block'), { code:'invalid-image-content' });
        i += n;
      }
      throw Object.assign(new Error('invalid-gif-block'), { code:'invalid-image-content' });
    };
    while (o < source.length) {
      const tag = source[o];
      if (tag === 0x3b) { chunks.push(source.subarray(o,o+1)); o += 1; break; }
      if (tag === 0x2c) {
        if (o + 10 > source.length) throw Object.assign(new Error('invalid-gif-image'), { code:'invalid-image-content' });
        let end = o + 10;
        const imagePacked = source[o + 9];
        if (imagePacked & 0x80) end += 3 * (1 << ((imagePacked & 0x07) + 1));
        if (end + 1 > source.length) throw Object.assign(new Error('invalid-gif-image'), { code:'invalid-image-content' });
        const blockEnd = consumeBlocks(end + 1); // LZW code-size byte + data blocks
        chunks.push(source.subarray(o,blockEnd)); o = blockEnd; continue;
      }
      if (tag === 0x21) {
        if (o + 2 > source.length) throw Object.assign(new Error('invalid-gif-extension'), { code:'invalid-image-content' });
        const label = source[o+1];
        let end;
        if (label === 0xf9) { // Graphic Control Extension, required for animation/transparency.
          if (o + 8 > source.length || source[o+2] !== 4 || source[o+7] !== 0) throw Object.assign(new Error('invalid-gif-control'), { code:'invalid-image-content' });
          end = o + 8; chunks.push(source.subarray(o,end)); o=end; continue;
        }
        if (label === 0xff) {
          if (o + 3 > source.length) throw Object.assign(new Error('invalid-gif-app'), { code:'invalid-image-content' });
          const headLen = source[o+2];
          const headEnd = o + 3 + headLen;
          if (headEnd > source.length) throw Object.assign(new Error('invalid-gif-app'), { code:'invalid-image-content' });
          end = consumeBlocks(headEnd);
          const ident = source.toString('ascii', o+3, headEnd).toUpperCase();
          // Preserve only animation-control application extensions. Other
          // application/comment/plain-text extensions may carry author/location data.
          if (ident.startsWith('NETSCAPE2.0') || ident.startsWith('ANIMEXTS1.0')) chunks.push(source.subarray(o,end));
          o=end; continue;
        }
        // Comment, Plain Text and unknown extension data are metadata; remove them.
        if (o + 3 > source.length) throw Object.assign(new Error('invalid-gif-extension'), { code:'invalid-image-content' });
        const headLen = source[o+2];
        const headEnd = o + 3 + headLen;
        if (headEnd > source.length) throw Object.assign(new Error('invalid-gif-extension'), { code:'invalid-image-content' });
        o = consumeBlocks(headEnd); continue;
      }
      throw Object.assign(new Error('invalid-gif-block'), { code:'invalid-image-content' });
    }
    output = Buffer.concat(chunks);
  } else {
    return { supported:false, changed:false, originalBytes:source.length, finalBytes:source.length };
  }

  const changed = !output.equals(source);
  if (changed) {
    const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.metadata.tmp`;
    await fs.promises.writeFile(tmp, output, { mode:0o600, flag:'wx' });
    try { await fs.promises.rename(tmp, filePath); }
    catch (error) { try { await fs.promises.unlink(tmp); } catch (_) {} throw error; }
  }
  return { supported:true, changed, originalBytes:source.length, finalBytes:output.length };
}

// Subtitles. Converts SubRip (.srt) to WebVTT (what <track> needs);
// .vtt is already fine. Cheap text transform, no dependency.

module.exports = { previewInfo, imageContentType, photoExt, imageDimensions, parseExifTiff, readPhotoMetadata, sanitizeImageMetadataFile };
