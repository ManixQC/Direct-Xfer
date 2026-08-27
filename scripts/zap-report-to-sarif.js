#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { array, parseMinRisk, parseRiskCode, collectAlerts, ruleIdentity } = require('./zap-report-utils');

const input = process.argv[2] || 'report_json.json';
const output = process.argv[3] || 'zap-security.sarif';
const minRisk = parseMinRisk();

function text(value) {
  return String(value == null ? '' : value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function levelFor(risk) { return risk >= 3 ? 'error' : risk >= 2 ? 'warning' : 'note'; }
function securitySeverityFor(risk) { return risk >= 3 ? '8.0' : risk >= 2 ? '6.0' : '3.0'; }

const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const alerts = collectAlerts(raw).filter((alert) => parseRiskCode(alert) >= minRisk);
const rules = new Map();
const results = [];
for (const alert of alerts) {
  const identity = ruleIdentity(alert);
  const ruleId = `zap/${identity.safe}`;
  const risk = parseRiskCode(alert);
  const name = text(alert.alert || alert.name || `ZAP alert ${identity.raw}`);
  const desc = text(alert.desc || alert.description || name);
  const solution = text(alert.solution || '');
  const reference = text(alert.reference || '');
  const cwe = String(alert.cweid || '').trim();

  if (!rules.has(ruleId)) {
    const tags = ['security', 'external/zap'];
    if (/^\d+$/.test(cwe) && cwe !== '0') tags.push(`external/cwe/cwe-${cwe}`);
    rules.set(ruleId, {
      id: ruleId,
      name: name.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || `ZAP_${identity.safe}`,
      shortDescription: { text: name },
      fullDescription: { text: desc || name },
      help: { text: [desc, solution && `Solution: ${solution}`, reference && `Reference: ${reference}`].filter(Boolean).join('\n\n') },
      properties: { tags, 'security-severity': securitySeverityFor(risk) },
    });
  }

  const instances = array(alert.instances);
  const urls = [...new Set(instances.map((x) => String((x && x.uri) || '').trim()).filter(Boolean))].sort().slice(0, 5);
  // ZAP groups current instances under one alert. Keep the fingerprint independent
  // from the URL set so new/removed affected endpoints update one GitHub alert.
  const fingerprint = crypto.createHash('sha256').update(ruleId).digest('hex');
  const detail = [name, `Risk: ${text(alert.riskdesc || risk)}`];
  if (urls.length) detail.push(`Observed at: ${urls.join(', ')}`);
  if (solution) detail.push(`Solution: ${solution}`);

  results.push({
    ruleId,
    level: levelFor(risk),
    message: { text: detail.join('\n') },
    locations: [{
      physicalLocation: { artifactLocation: { uri: 'security/zap-dast-target.md' }, region: { startLine: 1 } },
      message: { text: urls.length ? `Observed at ${urls.join(', ')}` : 'Observed by the Direct-Xfer OWASP ZAP baseline scan.' },
    }],
    partialFingerprints: { 'direct-xfer/zap-alert/v2': fingerprint },
    properties: {
      zapPluginId: identity.pluginId,
      zapAlertRef: identity.alertRef,
      zapRiskCode: risk,
      zapRiskDescription: text(alert.riskdesc || ''),
      zapConfidence: text(alert.confidence || ''),
      ...(cwe && cwe !== '0' ? { cwe } : {}),
    },
  });
}

const sarif = {
  version: '2.1.0',
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [{
    tool: { driver: { name: 'OWASP ZAP Baseline', informationUri: 'https://www.zaproxy.org/docs/docker/baseline-scan/', rules: [...rules.values()] } },
    automationDetails: { id: 'owasp-zap/baseline/' },
    results,
  }],
};

const resolvedOutput = path.resolve(output);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
const tempOutput = `${resolvedOutput}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tempOutput, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8');
  fs.renameSync(tempOutput, resolvedOutput);
} finally {
  try { fs.unlinkSync(tempOutput); } catch (_) {}
}
console.log(`OWASP ZAP SARIF: ${alerts.length} Medium/High alert(s) exported to ${output}.`);
