'use strict';

function applyWindowsInstallPreferences(state, env) {
  const markers = [];
  let changed = false;
  const prefs = [
    ['DX_WINDOWS_INSTALL_UPDATE_CHECK', 'DX_WINDOWS_INSTALL_UPDATE_CHECK_MARKER', 'updateCheck'],
    ['DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY', 'DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY_MARKER', 'publicIpDiscovery'],
  ];
  for (const [valueEnv, markerEnv, setting] of prefs) {
    const raw = String(env[valueEnv] || '').trim();
    if (raw !== '0' && raw !== '1') continue;
    const desired = raw === '1';
    if (state.settings[setting] !== desired) { state.settings[setting] = desired; changed = true; }
    if (env[markerEnv]) markers.push(env[markerEnv]);
  }
  return { changed, markers };
}

function consumeWindowsInstallPreferenceMarkers(fs, markers) {
  for (const marker of new Set(markers || [])) {
    try { fs.unlinkSync(marker); }
    catch (e) { if (e && e.code !== 'ENOENT') console.warn('[windows-install] could not consume preference marker:', e.message); }
  }
}

module.exports = { applyWindowsInstallPreferences, consumeWindowsInstallPreferenceMarkers };
