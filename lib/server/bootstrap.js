'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { StorageConnectorService } = require('../storage-connectors');

/**
 * Owns process-start side effects that must happen before HTTP composition:
 * managed directories, rclone runtime construction/cleanup and Windows firewall.
 */
function createRuntimeBootstrap(options = {}) {
  const config = options.config;
  if (!config || typeof config !== 'object') throw new TypeError('bootstrap requires config');
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const execFileImpl = options.execFile || execFile;
  const platform = options.platform || process.platform;
  const logger = options.logger || console;
  const StorageConnectorServiceImpl = options.StorageConnectorService || StorageConnectorService;

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function resolveRcloneBinary() {
    const configured = config.RCLONE_BIN;
    if (configured) return configured;
    if (platform === 'win32') {
      const bundled = pathImpl.resolve(config.rootDir, '..', 'rclone', 'rclone.exe');
      try { if (fsImpl.existsSync(bundled)) return bundled; } catch (_) {}
    }
    return 'rclone';
  }

  const storageConnectorService = new StorageConnectorServiceImpl({
    bin:resolveRcloneBinary(),
    configPath:config.RCLONE_CONFIG,
    importRoot:config.CONNECTOR_IMPORT_DIR,
  });
  const connectorStartupCleanup = Promise.resolve()
    .then(() => storageConnectorService.cleanupStaleImports())
    .then(() => true)
    .catch((error) => {
      logger.error('[connector] stale import cleanup failed:', errorMessage(error));
      return false;
    });

  // Preserve the historical order: encrypted/managed image directories are
  // created before storage mount diagnostics, while reception is created later.
  for (const dir of [
    config.ENC_DIR, config.SECRETS_DIR, config.IMAGE_STORE_DIR,
    config.FULL_IMAGES_DIR, config.THUMBS_DIR, config.MICROS_DIR,
    config.PHOTO_HISTORY_DIR, config.PHOTO_VERSIONS_DIR,
    config.ADAPTIVE_IMAGES_DIR, config.DLP_QUARANTINE_DIR,
  ]) {
    try { fsImpl.mkdirSync(dir, { recursive:true }); } catch (_) {}
  }
  const storageSetup = Object.freeze({
    inboxUnconfigured: config.IN_CONTAINER && config.folderUnconfigured(config.INBOX_DIR),
    imagesUnconfigured: config.IN_CONTAINER && config.folderUnconfigured(config.IMAGE_STORE_DIR),
  });

  let baseDirectoriesReady = false;
  function ensureBaseDirectories() {
    if (baseDirectoriesReady) return;
    fsImpl.mkdirSync(config.DATA_DIR, { recursive:true });
    try { fsImpl.mkdirSync(config.INBOX_DIR, { recursive:true }); } catch (_) {}
    baseDirectoriesReady = true;
  }

  function dataWritable() {
    try {
      fsImpl.accessSync(config.DATA_DIR, fsImpl.constants.W_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  function ensureWindowsPortableFirewallAccess() {
    if (platform !== 'win32' || !config.DX_WINDOWS_LAUNCHER_TOKEN) return;
    if (!(config.BIND === '0.0.0.0' || config.BIND === '::')) return;
    const ruleName = `Direct-Xfer-TCP-${config.PORT}`;
    const escapedName = ruleName.replace(/'/g, "''");
    const inspectPs = [
      `$n='${escapedName}';`,
      '$ok=$false;',
      'Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | ForEach-Object {',
      " if ($_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow') {",
      '  $r=$_; $p=$r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue; $a=$r | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue;',
      `  if ($p -and $p.Protocol -eq 'TCP' -and [string]$p.LocalPort -eq '${config.PORT}' -and $a -and @($a.RemoteAddress) -contains 'LocalSubnet') { $ok=$true }`,
      ' }',
      '};',
      "if ($ok) { Write-Output 'DX_FIREWALL_OK' }",
    ].join('');
    const inspectDone = (inspectError, stdout) => {
      if (!inspectError && String(stdout || '').includes('DX_FIREWALL_OK')) {
        logger.log(`  • Windows Firewall : rule ready for TCP ${config.PORT} (local subnet)`);
        return;
      }
      const elevatedPs = [
        `$n='${escapedName}';`,
        'Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue;',
        `New-NetFirewallRule -DisplayName $n -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${config.PORT} -Profile Any -RemoteAddress LocalSubnet -ErrorAction Stop | Out-Null`,
      ].join('');
      const encoded = Buffer.from(elevatedPs, 'utf16le').toString('base64');
      const elevate = `$p=Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Wait -PassThru; exit $p.ExitCode`;
      const elevateDone = (elevatedError) => {
        if (elevatedError) {
          logger.warn(`[windows] Firewall rule was not created (${errorMessage(elevatedError)}). Local access remains available; LAN access may be blocked. Allow TCP ${config.PORT} for Direct-Xfer from the local subnet in Windows Defender Firewall.`);
          return;
        }
        logger.log(`  • Windows Firewall : TCP ${config.PORT} allowed from the local subnet`);
      };
      try {
        execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', elevate], {
          windowsHide:true,
          timeout:120000,
          maxBuffer:256 * 1024,
        }, elevateDone);
      } catch (error) {
        elevateDone(error);
      }
    };
    try {
      execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspectPs], {
        windowsHide:true,
        timeout:15000,
        maxBuffer:256 * 1024,
      }, inspectDone);
    } catch (error) {
      inspectDone(error, '');
    }
  }

  return Object.freeze({
    storageConnectorService,
    connectorStartupCleanup,
    storageSetup,
    resolveRcloneBinary,
    ensureBaseDirectories,
    dataWritable,
    ensureWindowsPortableFirewallAccess,
  });
}

module.exports = { createRuntimeBootstrap };
