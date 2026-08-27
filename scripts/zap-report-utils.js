'use strict';

const crypto = require('node:crypto');

function array(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function parseMinRisk(value = process.env.ZAP_MIN_RISK) {
  const raw = value == null || String(value).trim() === '' ? '2' : String(value).trim();
  const risk = Number(raw);
  if (!Number.isInteger(risk) || risk < 0 || risk > 3) {
    throw new Error(`Invalid ZAP_MIN_RISK ${JSON.stringify(raw)}; expected an integer from 0 to 3.`);
  }
  return risk;
}

function alertLabel(alert) {
  return String(alert?.alertRef || alert?.pluginid || alert?.alert || alert?.name || 'unknown');
}

function parseRiskCode(alert) {
  const raw = alert && alert.riskcode;
  const risk = Number(raw);
  if (!Number.isInteger(risk) || risk < 0 || risk > 3) {
    throw new Error(`Invalid or missing ZAP riskcode for alert ${alertLabel(alert)}: ${JSON.stringify(raw)}`);
  }
  return risk;
}

function collectAlerts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid ZAP JSON report: expected an object.');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'site')) {
    throw new Error('Invalid ZAP JSON report: missing site collection.');
  }
  const sites = array(raw.site);
  if (sites.length === 0) {
    throw new Error('Invalid ZAP JSON report: site collection is empty.');
  }
  const out = [];
  for (const site of sites) {
    if (!site || typeof site !== 'object' || Array.isArray(site)) {
      throw new Error('Invalid ZAP JSON report: site entry is not an object.');
    }
    if (!Object.prototype.hasOwnProperty.call(site, 'alerts')) {
      throw new Error('Invalid ZAP JSON report: site entry is missing alerts collection.');
    }
    for (const alert of array(site.alerts)) {
      if (!alert || typeof alert !== 'object' || Array.isArray(alert)) {
        throw new Error('Invalid ZAP JSON report: alert entry is not an object.');
      }
      // Validate every alert, including Low/Info, so malformed scanner output can
      // never be silently interpreted as "no actionable findings".
      parseRiskCode(alert);
      out.push(alert);
    }
  }
  return out;
}

function ruleIdentity(alert) {
  const preferred = String(alert?.alertRef || '').trim();
  const fallback = String(alert?.pluginid || '').trim();
  const raw = preferred || fallback;
  if (!raw) throw new Error(`ZAP alert is missing both alertRef and pluginid (${alert?.alert || alert?.name || 'unnamed alert'}).`);
  const normalized = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) throw new Error(`ZAP alert has an unusable identity: ${JSON.stringify(raw)}`);
  // ZAP alertRef values are normally numeric/hyphen identifiers. If a future
  // scanner emits a value that needs normalization or truncation, append a hash
  // so distinct raw identities cannot collapse onto one SARIF rule.
  const changed = normalized !== raw || normalized.length > 120;
  const suffix = changed ? `-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}` : '';
  const safe = changed ? `${normalized.slice(0, Math.max(1, 120 - suffix.length))}${suffix}` : normalized;
  return { raw, safe, alertRef: preferred, pluginId: fallback };
}

module.exports = { array, parseMinRisk, parseRiskCode, collectAlerts, ruleIdentity };
