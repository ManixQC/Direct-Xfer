'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TextDecoder } = require('util');

const BINARY_EXTENSIONS = new Set([
  '.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.pdf',
  '.exe', '.dll', '.pdb', '.node', '.wasm', '.bin',
]);

const FALLBACK_EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'third_party', 'coverage', 'dist', 'build', 'releases',
]);

function walkFiles(cwd, relative = '') {
  const root = path.join(cwd, relative);
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (FALLBACK_EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...walkFiles(cwd, childRelative));
    } else if (entry.isFile()) {
      out.push(childRelative.split(path.sep).join('/'));
    }
  }
  return out;
}

function trackedFiles(cwd = process.cwd()) {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.toString('utf8').split('\0').filter(Boolean);
  } catch {
    // Source release ZIPs deliberately do not include .git. The filesystem
    // fallback keeps local release validation equivalent without weakening CI,
    // where git ls-files remains authoritative.
    return walkFiles(cwd);
  }
}

function validateTrackedUtf8(cwd = process.cwd(), files = trackedFiles(cwd)) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const invalid = [];
  let checked = 0;
  let skippedBinary = 0;

  for (const relative of files) {
    const ext = path.extname(relative).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      skippedBinary += 1;
      continue;
    }

    const absolute = path.join(cwd, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const data = fs.readFileSync(absolute);
    try {
      decoder.decode(data);
      checked += 1;
    } catch (error) {
      invalid.push({ relative, message: error && error.message ? error.message : String(error) });
    }
  }

  return { invalid, checked, skippedBinary };
}

function main() {
  const result = validateTrackedUtf8();
  if (result.invalid.length) {
    for (const item of result.invalid) {
      const escaped = item.message.replace(/[\r\n]+/g, ' ');
      console.error(`::error file=${item.relative}::Codacy text input is not valid UTF-8: ${escaped}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Codacy UTF-8 preflight PASS: ${result.checked} tracked text files; ${result.skippedBinary} binary assets skipped.`);
}

if (require.main === module) main();

module.exports = { BINARY_EXTENSIONS, FALLBACK_EXCLUDED_DIRS, walkFiles, trackedFiles, validateTrackedUtf8 };
