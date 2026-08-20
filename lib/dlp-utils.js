'use strict';

function dlpLuhnValid(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 9) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]); if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
function dlpIbanValid(value) {
  const iban = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const chunk = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of chunk) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
function dlpRedact(value) {
  const s = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return '';
  // DLP excerpts are for recognition, not reconstruction. The previous 4+4
  // scheme exposed 8 of 9 digits for a Canadian SIN and too much of cards/tokens.
  if (s.length <= 4) return s.slice(0, 1) + '…';
  if (s.length <= 8) return s.slice(0, 1) + '…' + s.slice(-1);
  return s.slice(0, 2) + '…' + s.slice(-2);
}
function dlpFinding(type, severity, file, sample, detail) {
  return { type, severity, file:String(file || '').slice(0, 512), sample:dlpRedact(sample), detail:String(detail || '').slice(0, 180) };
}
function detectDlpFindings(text, file) {
  text = String(text || '');
  const findings = [], seen = new Set();
  const add = (type, severity, sample, detail) => {
    const key = type + ':' + dlpRedact(sample); if (seen.has(key) || findings.length >= 100) return;
    seen.add(key); findings.push(dlpFinding(type, severity, file, sample, detail));
  };
  let m;
  const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gi;
  while ((m = privateKey.exec(text))) add('private-key','critical',m[0],'Private key material');
  const aws = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g; while ((m = aws.exec(text))) add('aws-access-key','critical',m[0],'AWS access key identifier');
  const github = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g; while ((m = github.exec(text))) add('github-token','critical',m[0],'GitHub token');
  const slack = /\bxox[baprs]-[A-Za-z0-9-]{10,200}\b/g; while ((m = slack.exec(text))) add('slack-token','critical',m[0],'Slack token');
  const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g; while ((m = jwt.exec(text))) add('jwt','high',m[0],'JSON Web Token');
  const password = /(?:password|passwd|pwd|mot\s+de\s+passe|passphrase|contrase(?:n|ñ)a)\s*[:=]\s*([^\s'";,]{6,128})/gi;
  while ((m = password.exec(text))) add('password','high',m[1],'Password-like assignment');
  const api = /(?:api[_ -]?key|secret[_ -]?key|access[_ -]?token|client[_ -]?secret|bearer)\s*[:=]?\s*['"]?([A-Za-z0-9_\-\/+=]{16,160})/gi;
  while ((m = api.exec(text))) add('api-secret','high',m[1],'API/token secret');
  const cards = /\b(?:\d[ -]*?){13,19}\b/g;
  while ((m = cards.exec(text))) {
    const digits = m[0].replace(/\D/g,'');
    if (digits.length >= 13 && digits.length <= 19 && dlpLuhnValid(digits)) add('payment-card','high',m[0],'Payment-card number (Luhn valid)');
  }
  const sinContext = /(?:\bSIN\b|\bNAS\b|social\s+insurance|assurance\s+sociale|numero\s+d['’]?assurance\s+sociale)[^\d]{0,30}(\d{3}[ -]?\d{3}[ -]?\d{3})/gi;
  while ((m = sinContext.exec(text))) if (dlpLuhnValid(m[1])) add('canadian-sin','high',m[1],'Canadian SIN/NAS (Luhn valid)');
  const iban = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/gi;
  while ((m = iban.exec(text))) if (dlpIbanValid(m[0])) add('iban','high',m[0],'IBAN (mod-97 valid)');
  const identity = /(?:passport|passeport|driver(?:'s)?\s+licen[cs]e|permis\s+de\s+conduire|pasaporte)[^A-Za-z0-9]{0,20}([A-Z0-9-]{5,24})/gi;
  while ((m = identity.exec(text))) add('identity-document','medium',m[1],'Identity-document number with context');
  const confidential = /\b(?:strictly\s+confidential|confidential|confidentiel|confidentielle|restricted|hautement\s+confidentiel|confidencial)\b/gi;
  while ((m = confidential.exec(text))) add('confidential-marker','medium',m[0],'Confidentiality marker');
  return findings;
}
function dlpSeverityRank(v) { return ({ low:1, medium:2, high:3, critical:4 })[String(v || '').toLowerCase()] || 0; }
function dlpPublicSummary(scan) {
  const findings = Array.isArray(scan && scan.findings) ? scan.findings : [];
  const filesScanned = Number(scan && scan.filesScanned) || 0;
  const filesSkipped = Number(scan && scan.filesSkipped) || 0;
  const ocrErrors = Number(scan && scan.ocrErrors) || 0;
  const scanErrors = Number(scan && scan.scanErrors) || 0;
  const incompleteEntries = Number(scan && scan.incompleteEntries) || 0;
  const truncated = !!(scan && scan.truncated);
  const ocrUnavailable = !!(scan && scan.ocrUnavailable);
  const maxBytes = Math.max(0, Number(scan && scan.maxBytes) || 0);
  const maxFileMB = maxBytes ? Math.round((maxBytes / (1024 * 1024)) * 10) / 10 : 0;
  return {
    filesScanned, filesSkipped, ocrErrors, scanErrors, incompleteEntries, truncated, ocrUnavailable, maxFileMB, incomplete:!!(filesSkipped || ocrErrors || scanErrors || incompleteEntries || truncated || ocrUnavailable),
    findings:findings.slice(0, 50).map((f) => ({ type:f.type, severity:f.severity, file:f.file, sample:f.sample, detail:f.detail })),
    count:findings.length,
    highest:findings.reduce((best, f) => dlpSeverityRank(f.severity) > dlpSeverityRank(best) ? f.severity : best, ''),
    types:[...new Set(findings.map((f) => f.type))].slice(0, 30),
  };
}
function mergeDlpSummaries(scans, extraSkipped) {
  const list = (scans || []).filter(Boolean);
  const findings = []; const types = new Set();
  let filesScanned = 0, filesSkipped = Math.max(0, Number(extraSkipped) || 0), ocrErrors = 0, scanErrors = 0, incompleteEntries = 0, count = 0, highest = '', truncated = filesSkipped > 0, ocrUnavailable = false, maxFileMB = 0;
  for (const scan of list) {
    filesScanned += Number(scan.filesScanned) || 0;
    filesSkipped += Number(scan.filesSkipped) || 0;
    ocrErrors += Number(scan.ocrErrors) || 0;
    scanErrors += Number(scan.scanErrors) || 0;
    incompleteEntries += Number(scan.incompleteEntries) || 0;
    count += Number(scan.count) || 0; truncated = truncated || !!scan.truncated; ocrUnavailable = ocrUnavailable || !!scan.ocrUnavailable; maxFileMB = Math.max(maxFileMB, Number(scan.maxFileMB) || 0);
    if (dlpSeverityRank(scan.highest) > dlpSeverityRank(highest)) highest = scan.highest;
    for (const type of (scan.types || [])) types.add(type);
    for (const f of (scan.findings || [])) if (findings.length < 50) findings.push(f);
  }
  return { filesScanned, filesSkipped, ocrErrors, scanErrors, incompleteEntries, truncated, ocrUnavailable, maxFileMB, incomplete:!!(filesSkipped || ocrErrors || scanErrors || incompleteEntries || truncated || ocrUnavailable), findings, count, highest, types:[...types].slice(0, 30) };
}

module.exports = {
  dlpLuhnValid, dlpIbanValid, dlpRedact, dlpFinding, detectDlpFindings,
  dlpSeverityRank, dlpPublicSummary, mergeDlpSummaries,
};
