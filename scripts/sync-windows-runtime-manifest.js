'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROGRAM_REL = 'windows-server-host/Program.cs';
const MANIFEST_START = 'private static readonly IDictionary<string, string> CriticalRuntimeSha256 =';
const MANIFEST_END = '        private readonly EventWaitHandle _stopEvent;';
const ENTRY_RE = /\{ "([^"]+)", "([0-9a-f]{64})" \}/g;

function normalizedSha256(file) {
  const normalized = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function previewProgram(source, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const allowMissing = options.allowMissing instanceof Set
    ? options.allowMissing
    : new Set(Array.isArray(options.allowMissing) ? options.allowMissing : []);
  const start = source.indexOf(MANIFEST_START);
  if (start < 0) throw new Error('CriticalRuntimeSha256 manifest start was not found');
  const end = source.indexOf(MANIFEST_END, start);
  if (end < 0) throw new Error('CriticalRuntimeSha256 manifest end was not found');

  const segment = source.slice(start, end);
  const rows = [...segment.matchAll(ENTRY_RE)].map((match) => ({ rel:match[1], currentHash:match[2] }));
  if (rows.length < 60) throw new Error(`CriticalRuntimeSha256 manifest is unexpectedly small (${rows.length} entries)`);

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.rel)) throw new Error(`Duplicate runtime manifest path: ${row.rel}`);
    seen.add(row.rel);
  }

  const entries = [];
  const missing = [];
  const unresolved = [];
  const replacement = segment.replace(ENTRY_RE, (full, rel, currentHash) => {
    const file = path.join(root, ...String(rel).split('/'));
    if (!fs.existsSync(file)) {
      missing.push(rel);
      if (!allowMissing.has(rel)) unresolved.push(rel);
      entries.push({ rel, hash:currentHash, currentHash, exists:false });
      return full;
    }
    const hash = normalizedSha256(file);
    entries.push({ rel, hash, currentHash, exists:true });
    return `{ "${rel}", "${hash}" }`;
  });

  if (unresolved.length) {
    throw new Error(`Runtime manifest source files are missing: ${unresolved.join(', ')}`);
  }

  return {
    content: source.slice(0, start) + replacement + source.slice(end),
    entries,
    missing,
    unresolved,
    changed: entries.some((entry) => entry.exists && entry.hash !== entry.currentHash),
  };
}

function syncProgram(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const program = path.join(root, ...PROGRAM_REL.split('/'));
  const source = fs.readFileSync(program, 'utf8');
  const preview = previewProgram(source, { root, allowMissing:options.allowMissing });
  if (options.write && preview.content !== source) {
    fs.writeFileSync(program, preview.content, 'utf8');
  }
  return preview;
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (write && check) {
    console.error('Choose only one of --write or --check.');
    process.exit(2);
  }
  try {
    const result = syncProgram({ write });
    if (check && result.changed) {
      console.error('Windows ServerHost runtime manifest is stale. Run: node scripts/sync-windows-runtime-manifest.js --write');
      process.exit(1);
    }
    const changed = result.entries.filter((entry) => entry.exists && entry.hash !== entry.currentHash).length;
    console.log(`[runtime-manifest] ${result.entries.length} entries, ${changed} hash update${changed === 1 ? '' : 's'}${write ? ' written' : ''}`);
  } catch (error) {
    console.error(`[runtime-manifest] ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
}

module.exports = { normalizedSha256, previewProgram, syncProgram };
