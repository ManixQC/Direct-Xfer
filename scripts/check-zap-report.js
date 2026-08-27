#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseMinRisk, parseRiskCode, collectAlerts, ruleIdentity } = require('./zap-report-utils');

const input = process.argv[2] || 'report_json.json';
const minRisk = parseMinRisk();
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const findings = collectAlerts(raw).filter((alert) => parseRiskCode(alert) >= minRisk);

if (findings.length) {
  console.error(`OWASP ZAP gate failed: ${findings.length} Medium/High baseline alert(s).`);
  for (const alert of findings.slice(0, 30)) {
    const identity = ruleIdentity(alert);
    console.error(`- [${alert.riskdesc || alert.riskcode}] ${alert.alert || alert.name || identity.raw} (rule ${identity.raw}${identity.pluginId && identity.pluginId !== identity.raw ? `; plugin ${identity.pluginId}` : ''})`);
  }
  if (findings.length > 30) console.error(`... ${findings.length - 30} additional alert(s) omitted from console output.`);
  process.exit(1);
}
console.log('OWASP ZAP gate PASS: no Medium/High baseline alerts.');
