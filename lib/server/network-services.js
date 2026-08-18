'use strict';

/**
 * Network diagnostics and external metadata services.
 * Owns public-IP discovery, update checks, TCP reachability and GeoIP caching.
 */
function createNetworkServices(deps) {
  const {
    net, os, LOCAL_IP, APP_VERSION, UPDATE_REPO, UPDATE_TAG,
    compareSemver, updateCheckEnabled, addAdminCenterNotification,
    getState, persist, maskToPrefix, ipToInt, intToIp, isPrivateIp,
    getSettings, flagFromCode, noteCenterServiceState,
  } = deps;
  const state = new Proxy({}, { get(_target, prop) { const current = getState(); return current && current[prop]; } });

// ===================================================================
//  NETWORK: IP detection + port test (check-host.net)
// ===================================================================

let publicIpCache = { value: null, at: 0 };
const PUBLIC_IP_TTL = 5 * 60 * 1000;

// Only exposes a local IP if the operator provided it via LOCAL_IP. Inside
// a container, auto-detection would only return the Docker bridge internal IP
// (misleading): so without LOCAL_IP, no local IP is displayed.
function getLocalIPv4s() {
  return LOCAL_IP ? [{ iface: 'lan', address: LOCAL_IP }] : [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}, timeoutMs = 7000) {
  const txt = await fetchText(url, opts, timeoutMs);
  return JSON.parse(txt);
}

// --- Update check (reads the Docker Hub tags of UPDATE_IMAGE) ---
const updateState = { current: APP_VERSION, latest: null, available: false, checkedAt: 0, error: null };

// Compares two "x.y.z" versions -> -1 | 0 | 1 (missing parts count as 0).
// Non-fatal: on any failure the previous state is kept.
async function checkForUpdate() {
  if (!updateCheckEnabled()) return;
  try {
    const url = `https://hub.docker.com/v2/repositories/${UPDATE_REPO}/tags?page_size=100`;
    const data = await fetchJson(url, {}, 8000);
    const results = Array.isArray(data && data.results) ? data.results : [];
    const isSemver = (n) => /^v?\d+\.\d+\.\d+$/.test(n);
    const ref = results.find((tg) => tg && tg.name === UPDATE_TAG);
    const refDigest = ref && ref.digest;

    let latest = null;
    if (refDigest) {
      const matches = results
        .filter((tg) => tg && tg.name !== UPDATE_TAG && isSemver(tg.name) && tg.digest === refDigest)
        .map((tg) => tg.name.replace(/^v/, ''));
      if (matches.length) latest = matches.sort(compareSemver).pop();
    }
    if (!latest) {
      const all = results.filter((tg) => tg && isSemver(tg.name)).map((tg) => tg.name.replace(/^v/, ''));
      if (all.length) latest = all.sort(compareSemver).pop();
    }

    if (latest) {
      Object.assign(updateState, {
        current: APP_VERSION,
        latest,
        available: compareSemver(latest, APP_VERSION) > 0,
        checkedAt: Date.now(),
        error: null,
      });
      if (updateState.available) {
        addAdminCenterNotification('update-available', { version:APP_VERSION, latest, detail:`${APP_VERSION} → ${latest}`, dedupeKey:`update-available:${latest}` });
      }
    } else {
      Object.assign(updateState, { checkedAt: Date.now(), error: 'no-version-tags' });
    }
  } catch (e) {
    Object.assign(updateState, { checkedAt: Date.now(), error: (e && e.message) || 'check-failed' });
  }
}

let publicIpInFlight = null;
async function getPublicIP(force = false) {
  const now = Date.now();
  if (!force && publicIpCache.value && now - publicIpCache.at < PUBLIC_IP_TTL) {
    return publicIpCache.value;
  }
  // Merges concurrent calls into a single network request.
  if (publicIpInFlight) return publicIpInFlight;
  publicIpInFlight = (async () => {
    const sources = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
    for (const url of sources) {
      try {
        const txt = (await fetchText(url)).trim();
        const ip = txt.split('\n')[0].trim();
        if (net.isIP(ip)) {
          const previous = state && state.meta && state.meta.notificationPublicIp ? String(state.meta.notificationPublicIp) : '';
          publicIpCache = { value: ip, at: Date.now() };
          if (state && state.meta) {
            if (previous && previous !== ip) addAdminCenterNotification('public-ip-changed',{previous,current:ip,detail:`${previous} → ${ip}`,dedupeKey:`public-ip:${previous}:${ip}`});
            if (previous !== ip) { state.meta.notificationPublicIp = ip; persist(); }
          }
          return ip;
        }
      } catch (_) {
        // next source
      }
    }
    return publicIpCache.value;
  })();
  try {
    return await publicIpInFlight;
  } finally {
    publicIpInFlight = null;
  }
}

// Non-blocking: serves the cache and refreshes in the background if stale.
function getPublicIPCached() {
  const now = Date.now();
  if (!publicIpCache.value || now - publicIpCache.at >= PUBLIC_IP_TTL) {
    getPublicIP(true).catch(() => {});
  }
  return publicIpCache.value;
}

// Interprets a check-host node result: true/false/null (pending).
function nodeState(value) {
  if (value == null) return null;
  const obj = Array.isArray(value) ? value[0] : value;
  if (obj == null) return null;
  if (typeof obj !== 'object') return false;
  if (obj.error) return false;
  return obj.time !== undefined || obj.address !== undefined;
}

async function checkPort(ip, port) {
  if (!ip) return { open: null, error: 'unknown-ip' };
  try {
    const start = await fetchJson(
      `https://check-host.net/check-tcp?host=${encodeURIComponent((net.isIP(ip) === 6 ? '[' + ip + ']' : ip) + ':' + port)}&max_nodes=3`,
      { headers: { Accept: 'application/json' } }
    );
    if (!start || start.ok === 0 || !start.request_id) {
      return { open: null, error: 'service-unavailable' };
    }
    const rid = start.request_id;
    for (let i = 0; i < 8; i++) {
      await sleep(1400);
      let results;
      try {
        results = await fetchJson(`https://check-host.net/check-result/${rid}`, {
          headers: { Accept: 'application/json' },
        });
      } catch (_) {
        continue;
      }
      if (!results) continue;
      const entries = Object.entries(results);
      if (entries.length === 0) continue;
      const states = entries.map(([, v]) => nodeState(v));
      const pending = states.filter((s) => s === null).length;
      const openCount = states.filter((s) => s === true).length;
      if (openCount > 0) return { open: true, openNodes: openCount, total: entries.length };
      if (pending === 0) return { open: false, openNodes: 0, total: entries.length };
    }
    return { open: null, error: 'timeout' };
  } catch (e) {
    return { open: null, error: e.message };
  }
}

// --- IP geolocation (country) ---
const geoCache = new Map(); // ip -> { country, countryCode, flag, at }
const GEO_TTL = 60 * 60 * 1000;

let localNetsCache = null;
function getLocalNets() {
  if (localNetsCache) return localNetsCache;
  const nets = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      let prefix = null;
      let addr = ni.address;
      if (ni.cidr) {
        const parts = ni.cidr.split('/');
        addr = parts[0];
        prefix = parseInt(parts[1], 10);
      } else if (ni.netmask) {
        prefix = maskToPrefix(ni.netmask);
      }
      if (!Number.isFinite(prefix) || prefix == null) continue;
      const base = ipToInt(addr);
      if (base == null) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      nets.push({ base: (base & mask) >>> 0, mask, cidr: intToIp((base & mask) >>> 0) + '/' + prefix });
    }
  }
  localNetsCache = nets;
  return nets;
}

// True if the IP belongs to the server's local network (loopback, detected
// subnet, or private range as a safety net).
function isLocalNetwork(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  // Fail closed when the peer address is unavailable. Treating an empty or
  // unknown address as local would bypass the LAN-only admin guard.
  if (!v || v === 'unknown') return false;
  if (v === '127.0.0.1' || v === '::1') return true;
  const n = ipToInt(v);
  if (n != null) {
    for (const net of getLocalNets()) {
      if (((n & net.mask) >>> 0) === net.base) return true;
    }
  }
  return isPrivateIp(v);
}

// --- IP allowlist for the admin (IPv4 IP or CIDR) ---
async function geolocate(ip) {
  const clean = String(ip || '').replace(/^::ffff:/i, '');
  if (isPrivateIp(clean)) return { country: 'Local network', countryCode: null, flag: '🏠' };
  // Privacy: when geolocation is disabled, make no external lookup.
  if (getSettings().geoLookup === false) return { country: null, countryCode: null, flag: '🌐' };

  const cached = geoCache.get(clean);
  if (cached && Date.now() - cached.at < GEO_TTL) return cached;

  let g = { country: null, countryCode: null, flag: '🌐', at: Date.now() };
  let geoProviderReachable = false;
  // 1) ipwho.is (HTTPS, no key)
  try {
    const d = await fetchJson(
      `https://ipwho.is/${encodeURIComponent(clean)}?fields=success,country,country_code,flag`,
      {},
      5000
    );
    // A valid response means the provider itself is reachable even when a
    // specific address cannot be geolocated. Do not report that as an outage.
    geoProviderReachable = !!d;
    if (d && d.success) {
      g = {
        country: d.country || null,
        countryCode: d.country_code || null,
        flag: (d.flag && d.flag.emoji) || flagFromCode(d.country_code),
        at: Date.now(),
      };
    }
  } catch (_) {}
  try {
    noteCenterServiceState('geoip', geoProviderReachable, geoProviderReachable ? 'Service GeoIP rétabli' : 'Service GeoIP indisponible');
  } catch (_) {}
  // No plaintext-HTTP fallback: visitor IPs and country access decisions must
  // never cross the network without transport encryption.
  geoCache.set(clean, g);
  return g;
}

  return {
    updateState,
    geoCache,
    GEO_TTL,
    getLocalIPv4s,
    checkForUpdate,
    getPublicIP,
    getPublicIPCached,
    checkPort,
    isLocalNetwork,
    geolocate,
  };
}

module.exports = { createNetworkServices };

