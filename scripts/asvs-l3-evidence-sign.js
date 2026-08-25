'use strict';

// Offline/audit-environment helper. The signing private key is intentionally not
// a Direct-Xfer runtime secret; keep it in the independent evidence pipeline.
const fs = require('fs');
const path = require('path');
const { signEvidenceBundle, sha256Canonical, validObservation, REQUIRED_DEPLOYMENT_REQUIREMENTS, REQUIRED_METHOD, MAX_EVIDENCE_TTL_MS, normalizePublicOrigin } = require('../lib/server/asvs-l3-evidence');

const [inputArg, outputArg, keyArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !keyArg) {
  console.error('Usage: node scripts/asvs-l3-evidence-sign.js <unsigned.json> <signed.json> <ed25519-private-key.pem>');
  process.exit(2);
}
const input = path.resolve(inputArg), output = path.resolve(outputArg), keyFile = path.resolve(keyArg);
const bundle = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(bundle.checks)) throw new Error('evidence bundle checks[] is required');

const now = Date.now();
if (bundle.evidenceVersion !== 1 || bundle.profile !== 'OWASP-ASVS-5.0.0-L3') throw new Error('invalid evidence profile/version');
if (!String(bundle.release || '').trim()) throw new Error('evidence release is required');
const publicOrigin = normalizePublicOrigin(bundle.publicOrigin);
if (!publicOrigin || String(bundle.publicOrigin || '').trim() !== publicOrigin) throw new Error('publicOrigin must be a canonical HTTPS origin without path, credentials, query, or fragment');
const generatedAt = Number(bundle.generatedAt) || 0, expiresAt = Number(bundle.expiresAt) || 0;
if (!generatedAt || generatedAt > now + 5 * 60 * 1000 || generatedAt < now - MAX_EVIDENCE_TTL_MS) throw new Error('generatedAt is invalid or stale');
if (!expiresAt || expiresAt <= generatedAt || expiresAt <= now || expiresAt - generatedAt > MAX_EVIDENCE_TTL_MS) throw new Error('expiresAt must be after generatedAt and no more than seven days later');

const ids = new Set(bundle.checks.map((r) => String(r && r.id || '')));
for (const id of REQUIRED_DEPLOYMENT_REQUIREMENTS) if (!ids.has(id)) throw new Error(`missing required evidence row ${id}`);
const seen = new Set();
for (const row of bundle.checks) {
  if (!row || typeof row !== 'object') throw new Error('invalid evidence row');
  const id = String(row.id || '');
  if (!id || seen.has(id)) throw new Error(`invalid/duplicate evidence row ${id || '(missing)'}`);
  seen.add(id);
  if (!REQUIRED_DEPLOYMENT_REQUIREMENTS.includes(id)) continue;
  if (row.status !== 'pass') throw new Error(`evidence row ${id} must have status=pass`);
  if (String(row.method || '') !== REQUIRED_METHOD[id]) throw new Error(`evidence row ${id} has invalid method`);
  const observedAt = Number(row.observedAt) || 0;
  if (!observedAt || observedAt < now - MAX_EVIDENCE_TTL_MS || observedAt > generatedAt + 5 * 60 * 1000 || observedAt > now + 5 * 60 * 1000) throw new Error(`evidence row ${id} has invalid/stale observedAt`);
  if (!validObservation(id, row.observation)) throw new Error(`evidence row ${id} observation does not satisfy the requirement`);
  row.digest = sha256Canonical(row.observation);
}
const signed = signEvidenceBundle(bundle, fs.readFileSync(keyFile, 'utf8'));
fs.writeFileSync(output, JSON.stringify(signed, null, 2) + '\n', { mode:0o600 });
console.log(`Signed ASVS L3 evidence written to ${output}`);
