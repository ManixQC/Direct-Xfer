#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const input = process.argv[2] || 'report_json.json';
const minRisk = Number(process.env.ZAP_MIN_RISK || 2);
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const sites = Array.isArray(raw.site) ? raw.site : raw.site ? [raw.site] : [];
const findings = [];
for (const site of sites) {
  const alerts = Array.isArray(site.alerts) ? site.alerts : site.alerts ? [site.alerts] : [];
  for (const alert of alerts) {
    const risk = Number(alert.riskcode || 0);
    if (Number.isFinite(risk) && risk >= minRisk) findings.push(alert);
  }
}

if (findings.length) {
  console.error(`OWASP ZAP gate failed: ${findings.length} Medium/High baseline alert(s).`);
  for (const alert of findings.slice(0, 30)) {
    console.error(`- [${alert.riskdesc || alert.riskcode}] ${alert.alert || alert.name || alert.pluginid} (plugin ${alert.pluginid || alert.alertRef || 'unknown'})`);
  }
  if (findings.length > 30) console.error(`... ${findings.length - 30} additional alert(s) omitted from console output.`);
  process.exit(1);
}
console.log('OWASP ZAP gate PASS: no Medium/High baseline alerts.');
