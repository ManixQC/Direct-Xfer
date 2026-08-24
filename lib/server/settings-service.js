'use strict';

// Owns the persisted Settings domain. All runtime-sensitive collaborators are
// injected by the composition root so reads keep following the live state object
// after a transactional restore.
function createSettingsService(deps = {}) {
  const {
    APP_NAME = 'Direct-Xfer',
    shutdownAfterDownload: SHUTDOWN_AFTER_DOWNLOAD = false,
    googleOAuthBrokerUrlEnv: GOOGLE_OAUTH_BROKER_URL_ENV = '',
    webhookUrl: WEBHOOK_URL = '',
    dataKey: DATA_KEY = '',
    smtpUrl: SMTP_URL = '',
    adminAllowedIps: ADMIN_ALLOWED_IPS = [],
    updateCheck: UPDATE_CHECK = true,
    publicIpDiscovery: PUBLIC_IP_DISCOVERY = true,
    maxUploadBytes: MAX_UPLOAD_BYTES = 0,
    tlsCert: TLS_CERT = '',
    tlsKey: TLS_KEY = '',
    tlsDayMs: TLS_DAY_MS = 86400000,
    nodemailer = null,
    webpush = null,
    tlsManager,
    getState,
    persist,
    persistNow,
    onSettingsChanged,
    getServerScheme,
    emailSendable,
    pushSubs,
    tlsManagedByEnvironment,
    configuredSelfSignedTls,
    configuredHttpsEnabled,
    localCaStatusForClient,
    normalizeLinkBase,
    cleanBrokerUrl,
    parseHotlinkHosts,
    normalizeShareColor,
    normalizeTags,
    normalizeDescriptionMd,
    normExtList,
    ipToInt,
    logger = console,
  } = deps;

  for (const [name, dependency] of Object.entries({
    getState,
    persist,
    persistNow,
    onSettingsChanged,
    getServerScheme,
    emailSendable,
    pushSubs,
    tlsManagedByEnvironment,
    configuredSelfSignedTls,
    configuredHttpsEnabled,
    localCaStatusForClient,
    normalizeLinkBase,
    cleanBrokerUrl,
    parseHotlinkHosts,
    normalizeShareColor,
    normalizeTags,
    normalizeDescriptionMd,
    normExtList,
    ipToInt,
  })) {
    if (typeof dependency !== 'function') throw new TypeError(`settings-service requires ${name}()`);
  }
  if (!tlsManager || typeof tlsManager !== 'object') throw new TypeError('settings-service requires tlsManager');

  const DEFAULT_SETTINGS = {
    shutdownAfterDownload: !!SHUTDOWN_AFTER_DOWNLOAD,
    linkBase: '',
    imageBase: '', // optional separate domain for direct image links (Images page); '' = use linkBase
    googleOAuthBrokerUrl: '', // persistent central Google OAuth broker URL; env DIRECT_XFER_OAUTH_BROKER_URL wins
    imageHotlinkHosts: [], // anti-hotlink allowlist of referring hosts; [] = allow any site
    pwChanged: false, // set to true after the mandatory password change on first login
    idleLockMinutes: 0, // auto-lock the admin UI after N minutes of inactivity (0 = off)
    announcement: '', // global banner shown on every public page ('' = none)
    // Notifications (webhook). The WEBHOOK_URL env var, when set, overrides webhookUrl.
    webhookUrl: '',
    webhookFormat: '', // '' = auto-detect from the URL
    notifyDownloads: true,
    notifyUploads: true,
    notifyMessages: true,
    // Anti-spam: coalesce received/downloaded notifications for the same
    // link within this many seconds into one digest (0 = off, send each immediately).
    notifyAggregateSeconds: 0,
    // Proactive "link expiring soon" alert. Fires once per link, this
    // many hours before its expiry, over the effective webhook.
    notifyExpiring: false,
    expiryWarnHours: 24,
    notifySecurity: false, // alert on sensitive events (login, lockout, settings change, …)
    // Ransomware/anomaly guard for writable public links.
    ransomwareProtection: true,
    ransomwareDeleteThreshold: 25, // file deletions within 60 s before the client is blocked
    ransomwareUploadThreshold: 120, // suspicious high-volume uploads within 120 s
    ransomwareBlockMinutes: 30,
    ransomwareSuspendLink: true, // freeze writes on the affected link as well as the attacking IP
    // Local Data Loss Prevention (DLP) before an outgoing share is published.
    // warn = require an explicit admin override, block = refuse, log = audit only.
    dlpEnabled: true,
    dlpMode: 'warn',
    // Optional severity-based automatic reactions. Legacy dlpMode remains the
    // fallback for incomplete scans and installations upgraded from older builds.
    dlpRulesEnabled: false,
    dlpActionLow: 'log',
    dlpActionMedium: 'warn',
    dlpActionHigh: 'quarantine',
    dlpActionCritical: 'block',
    dlpMaxFiles: 100,
    dlpMaxFileMB: 25,
    dlpScanOcr: true,
    // Periodic activity digest: a recap sent every N days over the
    // webhook (volume transferred, links nearing expiry, per-link activity).
    digestEnabled: false,
    digestDays: 7,
    // E-mail (SMTP) notifications. When enabled, the same events that go to the
    // webhook are also e-mailed. The SMTP_URL env var, when set, overrides these.
    emailEnabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false, // true = implicit TLS (port 465); false = STARTTLS
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    smtpTo: '',
    // Defaults pre-filled into the "new share" picker.
    defaultExpiry: 0, // seconds (0 = never)
    newSharesNeverExpire: false, // force newly-created links to ignore expiry values
    defaultMaxDownloads: 0, // 0 = unlimited
    defaultRateKBps: 0, // 0 = unlimited
    defaultAllowZip: true,
    defaultRequirePassword: false, // pre-require a password on new links
    defaultStartDelayHours: 0, // pre-fill a deferred activation (now + N hours)
    defaultAllowPreview: true, // allow in-browser preview on new shares
    defaultBurnAfterDownload: false, // pre-enable one-time (burn-after-download) links
    defaultShowQr: false, // auto-open the QR code right after creating a share
    defaultShareColor: '', // optional #RRGGBB dashboard accent for new links
    defaultShareTags: '', // comma-separated admin labels prefilled on new links
    defaultDescriptionMd: '', // optional Markdown description shown on public pages
    defaultExpiryReminderHours: -1, // -1 = inherit global alert, 0 = off, >0 = per-link lead time
    defaultFirstUseExpiryHours: 0, // expire N hours after first successful transfer (0 = off)
    defaultInactiveExpiryDays: 0, // expire after N days without public activity (0 = off)
    defaultShareDir: '', // starting folder for the "new share" picker ('' = last used / root)
    // Defaults pre-filled into the "reception link" picker.
    defaultMaxFiles: 0, // 0 = unlimited
    defaultMaxFileBytes: 0, // 0 = unlimited
    defaultMaxTotalBytes: 0, // 0 = unlimited
    defaultAllowExt: '', // comma list, '' = any
    defaultBlockExt: '', // comma list, '' = none
    defaultEncrypt: false, // pre-enable E2E encryption on reception links
    // Security.
    maxLoginAttempts: 5, // failed admin logins before a temporary lockout
    lockoutMinutes: 5, // lockout duration
    sessionHours: 0, // admin session lifetime (0 = SESSION_TTL env default)
    httpsWarning: true, // warn in the admin UI when served over plain HTTP off-LAN
    tlsLocalCa: false, // native HTTPS signed by a persistent Direct-Xfer Local CA; applied on restart
    tlsSelfSigned: false, // legacy <=1.57.3 setting; read for migration compatibility
    tokenBytes: 24, // random bytes for share/recipient link tokens (12–48)
    requireTwoFactor: false, // force every admin account to set up 2FA
    adminAllowedIps: '', // UI IP/CIDR allowlist for the admin (used when the env var is unset)
    // Global limits.
    globalRateKBps: 0, // hard server-wide download cap (0 = unlimited)
    maxUploadBytes: 0, // per received file cap (0 = use MAX_UPLOAD_BYTES env default)
    maxZipBytes: 0, // cap on a folder .zip download (0 = use MAX_ZIP_BYTES env default)
    // Server-wide cap on the TOTAL bytes received across every
    // reception/collaboration link (protects the /Direct-Xfer volume). 0 = unlimited.
    receptionStorageCapGB: 0,
    diskFreeWarnPercent: 10, // warn when free disk space falls to/below this percentage (0 = off)
    // Maintenance.
    updateCheck: true, // check for a newer version at startup (UPDATE_CHECK env can force off)
    publicIpDiscovery: true, // resolve the public IP via external services unless disabled
    // History / privacy.
    historyRetentionDays: 0, // auto-purge history older than N days (0 = keep all)
    logRetentionDays: 0, // purge transfers.log entries older than N days (0 = keep all)
    inboxRetentionDays: 0, // delete received files older than N days (0 = never)
    trashRetentionDays: 30, // keep manually deleted shares recoverable for N days (0 = keep forever)
    autoArchiveExpiredDays: 0, // automatically archive links N days after effective expiry (0 = off)
    expiredDataRetentionDays: 0, // permanently remove expired Direct-Xfer-managed data after N days (0 = off)
    anonymizeIps: false, // mask the last octet/hextet of IPs shown to the admin
    keepIpNames: true, // store per-IP visitor nicknames
    // Interface.
    confirmShareRevoke: true, // ask before revoking a share from the standard admin UI
    brandName: '', // '' = the built-in app name
    accentColor: '', // '' = default accent (#3b82f6)
    adminLang: '', // default admin UI language ('' = browser)
    publicLang: '', // default public-page language ('' = visitor's browser/cookie)
    receptionBanner: '', // default note/banner pre-filled on new reception links
    // Privacy: geolocate visitor IPs (external lookups). Off = no external calls.
    geoLookup: false,
    // Bandwidth cap by time-of-day window. When enabled, downloads are
    // additionally throttled to scheduleRateKBps (tighter of this / per-link /
    // global cap) while the local time is inside [scheduleStart, scheduleEnd).
    // The window may wrap past midnight (e.g. 08:00 → 02:00 = daytime + evening).
    scheduleRateEnabled: false,
    scheduleRateKBps: 0, // cap inside the window (0 = unlimited inside the window)
    scheduleStart: '08:00', // HH:MM (24h, server-local time)
    scheduleEnd: '18:00', // HH:MM; outside the window only the global/per-link caps apply
    // Anti-abuse on public download endpoints.
    publicRateLimit: true, // per-IP request rate limit on public download routes
    publicRateMax: 600, // high enough for chunked uploads while limiting floods
    publicRateWindowMin: 1, // sliding window length (minutes)
    challengeEnabled: false, // require a solved proof-of-work before large downloads
    challengeMinMB: 200, // files at least this large trigger the challenge (MB)
    challengeBits: 16, // proof-of-work difficulty (leading zero bits, 8–24)
    // "link likely leaked" alert: fires a one-shot notification when a
    // single link is downloaded from at least N distinct countries within a window.
    leakAlertEnabled: false,
    leakAlertCountries: 3, // distinct countries within the window that trigger the alert
    leakAlertWindowHours: 24, // rolling window + re-alert cooldown
    // Custom branding / watermark on public pages.
    publicLogo: '', // data: URL of a custom logo (replaces the built-in mark); '' = default
    legalNotice: '', // confidentiality/legal banner shown on every public page
    watermarkPreviews: false, // overlay the visitor IP / recipient name on image & video previews
    publicTheme: 'dark', // default public-page theme: 'dark', or 'auto' (follow the device) / 'light'
    themeColor: '', // mobile browser UI color (<meta name=theme-color>); '' = derive from accent/bg
    // Quick expiry presets offered in the link modals (comma list of
    // durations like "1h,6h,1d,7d,30d"). "Never" is always offered first.
    expiryPresets: '1h,1d,7d,30d',
    // Scheduled full backup + one-click restore. A backup bundles the whole store
    // (shares + settings), the transfer journal and the secret notes into one file,
    // encrypted with DATA_KEY when set. Pushed to a local folder, WebDAV or S3.
    backupEnabled: false,
    backupInterval: 'daily', // 'daily' | 'weekly'
    backupHour: 3, // local hour (0–23) the scheduled backup runs
    backupWeekday: 0, // 0=Sun … 6=Sat, for the weekly interval
    backupRetention: 7, // keep the last N backups (0 = keep all) — enforced for local & S3
    backupDestType: 'local', // 'local' | 'webdav' | 's3'
    backupLocalDir: '', // a writable (mounted) folder, e.g. /backups
    backupWebdavUrl: '', // collection URL, e.g. https://dav.example.com/direct-xfer/
    backupWebdavUser: '',
    backupWebdavPass: '', // sensitive: never returned to the client
    backupS3Endpoint: '', // e.g. https://s3.us-east-1.amazonaws.com (or a MinIO host)
    backupS3Region: 'us-east-1',
    backupS3Bucket: '',
    backupS3Prefix: '', // key prefix, e.g. backups/
    backupS3Key: '', // access key id
    backupS3Secret: '', // secret access key — sensitive: never returned to the client
  };

  function cloneSettingsRecord(settings) {
    const copy = { ...(settings || {}) };
    // Settings are otherwise scalar, but this allowlist is mutable. Never let a
    // caller mutate live state through a supposedly detached settings snapshot.
    if (Array.isArray(copy.imageHotlinkHosts)) copy.imageHotlinkHosts = [...copy.imageHotlinkHosts];
    return copy;
  }

  function mergedSettings(current, patch) {
    return cloneSettingsRecord({ ...(current || {}), ...(patch || {}) });
  }

  function noteSettingsChanged(phase) {
    try {
      onSettingsChanged();
      return true;
    } catch (error) {
      try { logger.warn(`[settings] ${phase} side effects failed:`, error && error.message ? error.message : error); } catch (_) {}
      return false;
    }
  }

  function restoreSettings(current, previous) {
    current.settings = previous;
    noteSettingsChanged('rollback');
  }

  function getSettings() {
    const current = getState();
    return cloneSettingsRecord(current && current.settings);
  }

  // Runtime feature/limit gates belong with the settings they resolve. Treat
  // restored/corrupt runtime settings defensively: byte limits stay finite and
  // privacy-sensitive network features fail closed unless their stored value is
  // an actual boolean true (undefined keeps the historical default-on behavior).
  function safePositiveByteLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
  }
  function effMaxUpload() {
    let settings = null;
    try { settings = getSettings(); } catch (_) {}
    const configured = safePositiveByteLimit(settings && settings.maxUploadBytes);
    if (configured > 0) return configured;
    return safePositiveByteLimit(MAX_UPLOAD_BYTES);
  }
  function runtimeBooleanGate(envEnabled, key) {
    if (!envEnabled) return false;
    let settings;
    try { settings = getSettings(); } catch (_) { return false; }
    const value = settings && settings[key];
    return value === undefined ? true : value === true;
  }
  function updateCheckEnabled() { return runtimeBooleanGate(!!UPDATE_CHECK, 'updateCheck'); }
  function publicIpDiscoveryEnabled() { return runtimeBooleanGate(!!PUBLIC_IP_DISCOVERY, 'publicIpDiscovery'); }

  function setSettings(patch) {
    const current = getState();
    const previous = current.settings;
    current.settings = mergedSettings(current.settings, patch);
    if (!noteSettingsChanged('apply')) {
      restoreSettings(current, previous);
      return null;
    }
    try { persist(); }
    catch (error) {
      try { logger.warn('[settings] persistence scheduling failed:', error && error.message ? error.message : error); } catch (_) {}
      restoreSettings(current, previous);
      return null;
    }
    return getSettings();
  }

  function setSettingsDurable(patch, options = {}) {
    const current = getState();
    const previous = current.settings;
    const beforePersist = options && typeof options.beforePersist === 'function' ? options.beforePersist : null;
    current.settings = mergedSettings(current.settings, patch);
    if (!noteSettingsChanged('apply')) {
      restoreSettings(current, previous);
      return null;
    }
    try {
      if (beforePersist) {
        const hookResult = beforePersist();
        if (hookResult && typeof hookResult.then === 'function') throw new TypeError('settings beforePersist hook must be synchronous');
      }
      if (persistNow()) return getSettings();
    } catch (error) {
      try { logger.warn('[settings] durable commit failed:', error && error.message ? error.message : error); } catch (_) {}
    }
    restoreSettings(current, previous);
    return null;
  }

  // Settings for the admin UI, with derived "managed by env" flags so the UI can
  // disable the fields the environment already controls. `pwChanged` is internal.
  // `lite` (used by the periodic poll) drops the possibly-large custom logo data URL — up
  // to ~256 KB — which the admin UI only needs when the Configuration modal is open
  // (it re-fetches the full settings then). A `publicLogoSet` flag is always sent.
  function settingsForClient(req, lite) {
    const state = getState();
    const SERVER_SCHEME = getServerScheme();
    const s = getSettings();
    const role = req && req.session && req.session.role;
    const fullAdmin = role === 'owner' || role === 'admin';
    const configurationReader = fullAdmin || role === 'auditor';
    delete s.pwChanged;
    s.googleOAuthBrokerManaged = !!GOOGLE_OAUTH_BROKER_URL_ENV; if (GOOGLE_OAUTH_BROKER_URL_ENV) s.googleOAuthBrokerUrl = GOOGLE_OAUTH_BROKER_URL_ENV; const hasPass = !!s.smtpPass;
    delete s.smtpPass; // never expose the SMTP password to the client
    const hasDavPass = !!s.backupWebdavPass;
    const hasS3Secret = !!s.backupS3Secret;
    delete s.backupWebdavPass; // sensitive backup credentials never leave the server
    delete s.backupS3Secret;
    const webhookUrlSet = !!(WEBHOOK_URL || s.webhookUrl);
    // Webhook URLs commonly contain an embedded secret. Operators and auditors
    // only need to know whether one is configured, never its value.
    if (!fullAdmin) delete s.webhookUrl;
    const publicLogoSet = !!s.publicLogo;
    if (lite) delete s.publicLogo; // keep the frequent poll small
    // Operators need creation defaults in the periodic /shares payload, not the
    // instance's infrastructure coordinates. Keep SMTP/backup/allow-list details
    // confined to owner/admin/auditor configuration reads.
    if (!configurationReader) {
      for (const key of [
        'adminAllowedIps',
        'smtpHost','smtpPort','smtpSecure','smtpUser','smtpFrom','smtpTo',
        'backupEnabled','backupInterval','backupHour','backupWeekday','backupRetention','backupDestType',
        'backupLocalDir','backupWebdavUrl','backupWebdavUser','backupS3Endpoint','backupS3Region',
        'backupS3Bucket','backupS3Prefix','backupS3Key',
      ]) delete s[key];
    }
    const client = {
      ...s,
      publicLogoSet,
      webhookUrlSet,
      webhookFromEnv: !!WEBHOOK_URL,
      dataEncrypted: !!DATA_KEY,
      emailFromEnv: !!SMTP_URL,
      emailAvailable: !!nodemailer,
      emailSendable: emailSendable(), // can e-mail an arbitrary recipient (the "e-mail this link" action)
      webPushAvailable: !!webpush, // the web-push module is installed on the server
      webPushSubs: pushSubs().length, // how many browsers are currently subscribed
      smtpPassSet: hasPass,
      backupWebdavPassSet: hasDavPass,
      backupS3SecretSet: hasS3Secret,
      lastBackup: (state.meta && state.meta.lastBackup) || null,
      allowlistFromEnv: ADMIN_ALLOWED_IPS.length > 0,
      updateCheckEnv: !UPDATE_CHECK, // env forces the update check off
      publicIpDiscoveryEnv: !PUBLIC_IP_DISCOVERY, // env can force public-IP discovery off
      tlsManagedByEnv: tlsManagedByEnvironment(),
      tlsProvidedCertificate: !!(TLS_CERT && TLS_KEY),
      tlsProvidedCertificateExpiresAt: tlsManager.activeProvidedTlsExpiresAt || 0,
      tlsLocalCaEffective: !(TLS_CERT && TLS_KEY) && configuredSelfSignedTls(),
      tlsSelfSignedEffective: !(TLS_CERT && TLS_KEY) && configuredSelfSignedTls(), // legacy client compatibility
      ...(() => { const ca = localCaStatusForClient(!(TLS_CERT && TLS_KEY)); return {
        tlsLocalCaAvailable: ca.available,
        tlsLocalCaSigningAvailable: !!ca.signingAvailable,
        tlsLocalCaFingerprint: ca.fingerprint || '',
        tlsLocalCaError: ca.error || '',
        tlsLocalCaExpiresAt: ca.expiresAt || 0,
        tlsLocalCaExpiresSoon: !!(ca.expiresAt && ca.expiresAt <= Date.now() + 365 * TLS_DAY_MS),
        tlsLocalCaServerExpiresAt: ca.serverExpiresAt || 0,
        tlsLocalCaDns: ca.identities ? ca.identities.dns : [],
        tlsLocalCaIps: ca.identities ? ca.identities.ips : [],
      }; })(),
      tlsActiveMode: tlsManager.ACTIVE_TLS_MODE,
      tlsActive: (typeof SERVER_SCHEME !== 'undefined' && SERVER_SCHEME === 'https'),
      tlsRestartRequired: !!tlsManager.tlsCertificateRestartRequired || ((typeof SERVER_SCHEME !== 'undefined') && (configuredHttpsEnabled() !== (SERVER_SCHEME === 'https'))),
      role: (req && req.session && req.session.role) || null, // current account's role (UI gating)
      appName: APP_NAME,
    };
    if (!configurationReader) {
      for (const key of ['smtpPassSet','backupWebdavPassSet','backupS3SecretSet','lastBackup','allowlistFromEnv']) delete client[key];
    }
    return client;
  }

  // Validates a settings object (from the config form OR an imported file) and
  // returns { patch } to apply, or { error } on the first invalid field.
  function computeSettingsPatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'invalid-settings' };
    const patch = {};
    const nonNegativeInt = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null; };
    const clampNum = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    if (typeof body.shutdownAfterDownload === 'boolean') {
      patch.shutdownAfterDownload = body.shutdownAfterDownload;
    }
    if (typeof body.linkBase === 'string') {
      const norm = normalizeLinkBase(body.linkBase);
      if (norm === null) return { error: 'invalid-domain' };
      patch.linkBase = norm; // '' = auto-detection
    }
    if (typeof body.imageBase === 'string') {
      const norm = normalizeLinkBase(body.imageBase);
      if (norm === null) return { error: 'invalid-domain' };
      patch.imageBase = norm; // '' = fall back to linkBase
    }
    if (typeof body.googleOAuthBrokerUrl === 'string' && !GOOGLE_OAUTH_BROKER_URL_ENV) {
      const raw = String(body.googleOAuthBrokerUrl || '').trim(); try { patch.googleOAuthBrokerUrl = raw ? cleanBrokerUrl(raw) : ''; }
      catch (_) { return { error:'invalid-oauth-broker-url' }; }
    }
    if (body.imageHotlinkHosts !== undefined) {
      patch.imageHotlinkHosts = parseHotlinkHosts(body.imageHotlinkHosts); // [] = allow any site
    }
    if (body.idleLockMinutes !== undefined) {
      const n = Math.floor(Number(body.idleLockMinutes));
      patch.idleLockMinutes = Number.isFinite(n) ? Math.min(1440, Math.max(0, n)) : 0; // 0 = off, cap 24h
    }
    // Notifications (webhook). Ignored while WEBHOOK_URL is set by the environment.
    if (typeof body.webhookUrl === 'string') {
      const u = body.webhookUrl.trim();
      if (u && !/^https?:\/\//i.test(u)) return { error: 'invalid-webhook' };
      patch.webhookUrl = u.slice(0, 500);
    }
    if (typeof body.webhookFormat === 'string') {
      patch.webhookFormat = ['', 'auto', 'discord', 'slack', 'ntfy', 'json'].includes(body.webhookFormat)
        ? (body.webhookFormat === 'auto' ? '' : body.webhookFormat) : '';
    }
    if (typeof body.notifyDownloads === 'boolean') patch.notifyDownloads = body.notifyDownloads;
    if (typeof body.notifyUploads === 'boolean') patch.notifyUploads = body.notifyUploads;
    if (typeof body.notifyMessages === 'boolean') patch.notifyMessages = body.notifyMessages;
    if (body.notifyAggregateSeconds !== undefined) patch.notifyAggregateSeconds = clampNum(body.notifyAggregateSeconds, 0, 3600, 0); // 0 = off, else 1s–1h window
    // Proactive expiry alerts and periodic digest.
    if (typeof body.notifyExpiring === 'boolean') patch.notifyExpiring = body.notifyExpiring;
    if (body.expiryWarnHours !== undefined) patch.expiryWarnHours = clampNum(body.expiryWarnHours, 1, 8760, 24); // cap 1y
    if (typeof body.digestEnabled === 'boolean') patch.digestEnabled = body.digestEnabled;
    if (body.digestDays !== undefined) patch.digestDays = clampNum(body.digestDays, 1, 90, 7);
    if (typeof body.notifySecurity === 'boolean') patch.notifySecurity = body.notifySecurity;
    if (typeof body.ransomwareProtection === 'boolean') patch.ransomwareProtection = body.ransomwareProtection;
    if (body.ransomwareDeleteThreshold !== undefined) patch.ransomwareDeleteThreshold = clampNum(body.ransomwareDeleteThreshold, 5, 1000, 25);
    if (body.ransomwareUploadThreshold !== undefined) patch.ransomwareUploadThreshold = clampNum(body.ransomwareUploadThreshold, 20, 5000, 120);
    if (body.ransomwareBlockMinutes !== undefined) patch.ransomwareBlockMinutes = clampNum(body.ransomwareBlockMinutes, 1, 1440, 30);
    if (typeof body.ransomwareSuspendLink === 'boolean') patch.ransomwareSuspendLink = body.ransomwareSuspendLink;
    if (typeof body.dlpEnabled === 'boolean') patch.dlpEnabled = body.dlpEnabled;
    if (body.dlpMode !== undefined) {
      const mode = String(body.dlpMode || '').toLowerCase();
      if (!['warn','block','log','quarantine'].includes(mode)) return { error: 'invalid-dlp-mode' };
      patch.dlpMode = mode;
    }
    if (typeof body.dlpRulesEnabled === 'boolean') patch.dlpRulesEnabled = body.dlpRulesEnabled;
    for (const [field, key] of [['dlpActionLow','dlpActionLow'],['dlpActionMedium','dlpActionMedium'],['dlpActionHigh','dlpActionHigh'],['dlpActionCritical','dlpActionCritical']]) {
      if (body[field] !== undefined) {
        const action = String(body[field] || '').toLowerCase();
        if (!['log','warn','quarantine','block'].includes(action)) return { error:'invalid-dlp-action' };
        patch[key] = action;
      }
    }
    if (body.dlpMaxFiles !== undefined) patch.dlpMaxFiles = clampNum(body.dlpMaxFiles, 1, 1000, 100);
    if (body.dlpMaxFileMB !== undefined) patch.dlpMaxFileMB = clampNum(body.dlpMaxFileMB, 1, 250, 25);
    if (typeof body.dlpScanOcr === 'boolean') patch.dlpScanOcr = body.dlpScanOcr;
    // E-mail (SMTP) notifications. Ignored while SMTP_URL is set by env.
    const emailStr = (v, max) => String(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
    if (typeof body.emailEnabled === 'boolean') patch.emailEnabled = body.emailEnabled;
    if (typeof body.smtpHost === 'string') patch.smtpHost = emailStr(body.smtpHost, 200);
    if (body.smtpPort !== undefined) patch.smtpPort = clampNum(body.smtpPort, 1, 65535, 587);
    if (typeof body.smtpSecure === 'boolean') patch.smtpSecure = body.smtpSecure;
    if (typeof body.smtpUser === 'string') patch.smtpUser = emailStr(body.smtpUser, 200);
    if (typeof body.smtpPass === 'string') patch.smtpPass = String(body.smtpPass).slice(0, 200); // kept as-is (may contain spaces)
    if (typeof body.smtpFrom === 'string') patch.smtpFrom = emailStr(body.smtpFrom, 200);
    if (typeof body.smtpTo === 'string') patch.smtpTo = emailStr(body.smtpTo, 400);
    // Defaults for new links.
    if (body.defaultExpiry !== undefined) { const n=nonNegativeInt(body.defaultExpiry); if(n===null)return {error:'invalid-limit'}; patch.defaultExpiry=n; }
    if (typeof body.newSharesNeverExpire === 'boolean') patch.newSharesNeverExpire = body.newSharesNeverExpire;
    if (body.defaultMaxDownloads !== undefined) { const n=nonNegativeInt(body.defaultMaxDownloads); if(n===null)return {error:'invalid-limit'}; patch.defaultMaxDownloads=n; }
    if (body.defaultRateKBps !== undefined) { const n=nonNegativeInt(body.defaultRateKBps); if(n===null)return {error:'invalid-limit'}; patch.defaultRateKBps=n; }
    if (typeof body.defaultAllowZip === 'boolean') patch.defaultAllowZip = body.defaultAllowZip;
    if (typeof body.defaultRequirePassword === 'boolean') patch.defaultRequirePassword = body.defaultRequirePassword;
    if (body.defaultStartDelayHours !== undefined) patch.defaultStartDelayHours = clampNum(body.defaultStartDelayHours, 0, 17520, 0); // cap 2y
    if (typeof body.defaultAllowPreview === 'boolean') patch.defaultAllowPreview = body.defaultAllowPreview;
    if (typeof body.defaultBurnAfterDownload === 'boolean') patch.defaultBurnAfterDownload = body.defaultBurnAfterDownload;
    if (typeof body.defaultShowQr === 'boolean') patch.defaultShowQr = body.defaultShowQr;
    if (body.defaultShareColor !== undefined) { const c = normalizeShareColor(body.defaultShareColor); if (c !== null) patch.defaultShareColor = c; }
    if (typeof body.defaultShareTags === 'string') patch.defaultShareTags = normalizeTags(body.defaultShareTags).join(',');
    if (typeof body.defaultDescriptionMd === 'string') patch.defaultDescriptionMd = normalizeDescriptionMd(body.defaultDescriptionMd);
    if (body.defaultExpiryReminderHours !== undefined) {
      const n = Number(body.defaultExpiryReminderHours);
      if (!Number.isFinite(n) || n < -1) return { error: 'invalid-reminder' };
      patch.defaultExpiryReminderHours = Math.max(-1, Math.min(8760, Math.round(n * 10) / 10));
    }
    if (body.defaultFirstUseExpiryHours !== undefined) {
      const n = Number(body.defaultFirstUseExpiryHours);
      if (!Number.isFinite(n) || n < 0) return { error: 'invalid-duration' };
      patch.defaultFirstUseExpiryHours = Math.min(87600, Math.round(n * 10) / 10);
    }
    if (body.defaultInactiveExpiryDays !== undefined) {
      const n = Number(body.defaultInactiveExpiryDays);
      if (!Number.isFinite(n) || n < 0) return { error: 'invalid-duration' };
      patch.defaultInactiveExpiryDays = Math.min(3650, Math.round(n * 10) / 10);
    }
    // Link lifecycle automation. Both are opt-in; permanent
    // cleanup stays disabled by default because it may delete managed inbox/photo bytes.
    if (body.autoArchiveExpiredDays !== undefined) patch.autoArchiveExpiredDays = clampNum(body.autoArchiveExpiredDays, 0, 3650, 0);
    if (body.expiredDataRetentionDays !== undefined) patch.expiredDataRetentionDays = clampNum(body.expiredDataRetentionDays, 0, 3650, 0);
    // Starting folder for the new-share picker. Stored as-is (trimmed); the /api/browse
    // endpoint re-validates the HOST_ROOT boundary when the picker actually opens it.
    if (typeof body.defaultShareDir === 'string') patch.defaultShareDir = body.defaultShareDir.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 4096);
    // Reception-link defaults.
    if (body.defaultMaxFiles !== undefined) { const n=nonNegativeInt(body.defaultMaxFiles); if(n===null)return {error:'invalid-limit'}; patch.defaultMaxFiles=n; }
    if (body.defaultMaxFileBytes !== undefined) { const n=nonNegativeInt(body.defaultMaxFileBytes); if(n===null)return {error:'invalid-limit'}; patch.defaultMaxFileBytes=n; }
    if (body.defaultMaxTotalBytes !== undefined) { const n=nonNegativeInt(body.defaultMaxTotalBytes); if(n===null)return {error:'invalid-limit'}; patch.defaultMaxTotalBytes=n; }
    if (typeof body.defaultAllowExt === 'string') patch.defaultAllowExt = normExtList(body.defaultAllowExt).join(', ');
    if (typeof body.defaultBlockExt === 'string') patch.defaultBlockExt = normExtList(body.defaultBlockExt).join(', ');
    if (typeof body.defaultEncrypt === 'boolean') patch.defaultEncrypt = body.defaultEncrypt;
    // Security.
    if (body.maxLoginAttempts !== undefined) patch.maxLoginAttempts = clampNum(body.maxLoginAttempts, 1, 100, 5);
    if (body.lockoutMinutes !== undefined) patch.lockoutMinutes = clampNum(body.lockoutMinutes, 1, 1440, 5);
    if (body.sessionHours !== undefined) patch.sessionHours = clampNum(body.sessionHours, 0, 720, 0); // 0 = env default, cap 30d
    if (typeof body.httpsWarning === 'boolean') patch.httpsWarning = body.httpsWarning;
    if (typeof body.tlsLocalCa === 'boolean' && !tlsManagedByEnvironment()) {
      patch.tlsLocalCa = body.tlsLocalCa;
      patch.tlsSelfSigned = false; // migrate away from the legacy 1.57.3 flag
    } else if (typeof body.tlsSelfSigned === 'boolean' && !tlsManagedByEnvironment()) {
      patch.tlsLocalCa = body.tlsSelfSigned;
      patch.tlsSelfSigned = false;
    }
    if (body.tokenBytes !== undefined) patch.tokenBytes = clampNum(body.tokenBytes, 12, 48, 24);
    if (typeof body.requireTwoFactor === 'boolean') patch.requireTwoFactor = body.requireTwoFactor;
    if (typeof body.adminAllowedIps === 'string') {
      // Security-sensitive fail-closed validation: silently dropping a typo here can
      // turn an intended allow-list into an empty list (= unrestricted admin access).
      const toks = body.adminAllowedIps.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      for (const tok of toks) {
        const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(tok);
        const prefix = m && m[2] !== undefined ? Number(m[2]) : 32;
        if (!m || ipToInt(m[1]) == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
          return { error:'invalid-admin-ip' };
        }
      }
      patch.adminAllowedIps = toks.join(', ').slice(0, 500);
    }
    // Global limits.
    if (body.globalRateKBps !== undefined) { const n=nonNegativeInt(body.globalRateKBps); if(n===null)return {error:'invalid-limit'}; patch.globalRateKBps=n; }
    if (body.maxUploadBytes !== undefined) { const n=nonNegativeInt(body.maxUploadBytes); if(n===null)return {error:'invalid-limit'}; patch.maxUploadBytes=n; }
    if (body.maxZipBytes !== undefined) { const n=nonNegativeInt(body.maxZipBytes); if(n===null)return {error:'invalid-limit'}; patch.maxZipBytes=n; }
    if (body.receptionStorageCapGB !== undefined) { // fractional GB allowed
      const capGb = Number(body.receptionStorageCapGB);
      if (!Number.isFinite(capGb) || capGb < 0) return { error:'invalid-limit' };
      patch.receptionStorageCapGB = capGb > 0 ? Math.min(1048576, capGb) : 0;
    }
    if (body.diskFreeWarnPercent !== undefined) patch.diskFreeWarnPercent = clampNum(body.diskFreeWarnPercent, 0, 50, 10);
    // Maintenance.
    if (typeof body.updateCheck === 'boolean') patch.updateCheck = body.updateCheck;
    if (typeof body.publicIpDiscovery === 'boolean') patch.publicIpDiscovery = body.publicIpDiscovery;
    // History / privacy.
    if (body.historyRetentionDays !== undefined) patch.historyRetentionDays = clampNum(body.historyRetentionDays, 0, 3650, 0);
    if (body.logRetentionDays !== undefined) patch.logRetentionDays = clampNum(body.logRetentionDays, 0, 3650, 0);
    if (body.inboxRetentionDays !== undefined) patch.inboxRetentionDays = clampNum(body.inboxRetentionDays, 0, 3650, 0);
    if (body.trashRetentionDays !== undefined) patch.trashRetentionDays = clampNum(body.trashRetentionDays, 0, 3650, 30);
    if (typeof body.anonymizeIps === 'boolean') patch.anonymizeIps = body.anonymizeIps;
    if (typeof body.keepIpNames === 'boolean') patch.keepIpNames = body.keepIpNames;
    // Interface.
    if (typeof body.confirmShareRevoke === 'boolean') patch.confirmShareRevoke = body.confirmShareRevoke;
    if (typeof body.brandName === 'string') patch.brandName = body.brandName.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
    if (typeof body.accentColor === 'string') {
      const c = body.accentColor.trim();
      if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return { error: 'invalid-color' };
      patch.accentColor = c;
    }
    const langOk = (v) => ['', 'fr', 'en', 'es'].includes(v);
    if (typeof body.adminLang === 'string' && langOk(body.adminLang)) patch.adminLang = body.adminLang;
    if (typeof body.publicLang === 'string' && langOk(body.publicLang)) patch.publicLang = body.publicLang;
    if (typeof body.receptionBanner === 'string') patch.receptionBanner = body.receptionBanner.replace(/\r\n/g, '\n').trim().slice(0, 2000);
    // Privacy.
    if (typeof body.geoLookup === 'boolean') patch.geoLookup = body.geoLookup;
    // Scheduled bandwidth cap.
    if (typeof body.scheduleRateEnabled === 'boolean') patch.scheduleRateEnabled = body.scheduleRateEnabled;
    if (body.scheduleRateKBps !== undefined) { const n=nonNegativeInt(body.scheduleRateKBps); if(n===null)return {error:'invalid-limit'}; patch.scheduleRateKBps=n; }
    const hhmm = (v, dflt) => {
      const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v).trim());
      if (!m) return dflt;
      const h = Number(m[1]), mi = Number(m[2]);
      if (h > 23 || mi > 59) return dflt;
      return `${String(h).padStart(2, '0')}:${m[2]}`;
    };
    if (body.scheduleStart !== undefined) patch.scheduleStart = hhmm(body.scheduleStart, '08:00');
    if (body.scheduleEnd !== undefined) patch.scheduleEnd = hhmm(body.scheduleEnd, '18:00');
    // Anti-abuse.
    if (typeof body.publicRateLimit === 'boolean') patch.publicRateLimit = body.publicRateLimit;
    if (body.publicRateMax !== undefined) patch.publicRateMax = clampNum(body.publicRateMax, 1, 100000, 600);
    if (body.publicRateWindowMin !== undefined) patch.publicRateWindowMin = clampNum(body.publicRateWindowMin, 1, 1440, 1);
    if (typeof body.challengeEnabled === 'boolean') patch.challengeEnabled = body.challengeEnabled;
    if (body.challengeMinMB !== undefined) patch.challengeMinMB = clampNum(body.challengeMinMB, 1, 1048576, 200);
    if (body.challengeBits !== undefined) patch.challengeBits = clampNum(body.challengeBits, 8, 24, 16);
    if (typeof body.leakAlertEnabled === 'boolean') patch.leakAlertEnabled = body.leakAlertEnabled;
    if (body.leakAlertCountries !== undefined) patch.leakAlertCountries = clampNum(body.leakAlertCountries, 2, 100, 3);
    if (body.leakAlertWindowHours !== undefined) patch.leakAlertWindowHours = clampNum(body.leakAlertWindowHours, 1, 720, 24);
    // Branding / watermark.
    if (typeof body.publicLogo === 'string') {
      const v = body.publicLogo.trim();
      if (v && !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { error: 'invalid-logo' };
      if (v.length > 262144) return { error: 'logo-too-large' }; // ~256 KB data URL cap
      patch.publicLogo = v;
    }
    if (typeof body.legalNotice === 'string') patch.legalNotice = body.legalNotice.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
    if (typeof body.announcement === 'string') patch.announcement = body.announcement.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
    if (typeof body.watermarkPreviews === 'boolean') patch.watermarkPreviews = body.watermarkPreviews;
    if (typeof body.publicTheme === 'string') patch.publicTheme = ['auto', 'dark', 'light'].includes(body.publicTheme) ? body.publicTheme : 'dark';
    if (typeof body.themeColor === 'string') {
      const c = body.themeColor.trim();
      if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return { error: 'invalid-color' };
      patch.themeColor = c;
    }
    // Expiry presets: keep only well-formed duration tokens (Nh/Nd/Nw/Nmo),
    // de-duplicated, max 8. Empty falls back to the default set client-side.
    if (typeof body.expiryPresets === 'string') {
      const seen = new Set();
      const toks = body.expiryPresets.split(/[,\s]+/).map((x) => x.trim().toLowerCase())
        .filter((x) => /^\d{1,4}(h|d|w|mo)$/.test(x) && !seen.has(x) && seen.add(x));
      patch.expiryPresets = toks.slice(0, 8).join(',');
    }
    // Scheduled backup + restore.
    const oneLine = (v, max) => String(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
    if (typeof body.backupEnabled === 'boolean') patch.backupEnabled = body.backupEnabled;
    if (typeof body.backupInterval === 'string') patch.backupInterval = body.backupInterval === 'weekly' ? 'weekly' : 'daily';
    if (body.backupHour !== undefined) patch.backupHour = clampNum(body.backupHour, 0, 23, 3);
    if (body.backupWeekday !== undefined) patch.backupWeekday = clampNum(body.backupWeekday, 0, 6, 0);
    if (body.backupRetention !== undefined) patch.backupRetention = clampNum(body.backupRetention, 0, 3650, 7);
    if (typeof body.backupDestType === 'string') patch.backupDestType = ['local', 'webdav', 's3'].includes(body.backupDestType) ? body.backupDestType : 'local';
    if (typeof body.backupLocalDir === 'string') patch.backupLocalDir = oneLine(body.backupLocalDir, 500);
    if (typeof body.backupWebdavUrl === 'string') {
      const u = body.backupWebdavUrl.trim();
      if (u && !/^https?:\/\//i.test(u)) return { error: 'invalid-webdav' };
      patch.backupWebdavUrl = u.slice(0, 500);
    }
    if (typeof body.backupWebdavUser === 'string') patch.backupWebdavUser = oneLine(body.backupWebdavUser, 200);
    if (typeof body.backupWebdavPass === 'string') patch.backupWebdavPass = String(body.backupWebdavPass).slice(0, 400); // kept as-is
    if (typeof body.backupS3Endpoint === 'string') {
      const u = body.backupS3Endpoint.trim();
      if (u && !/^https?:\/\//i.test(u)) return { error: 'invalid-s3-endpoint' };
      patch.backupS3Endpoint = u.slice(0, 500);
    }
    if (typeof body.backupS3Region === 'string') patch.backupS3Region = oneLine(body.backupS3Region, 60) || 'us-east-1';
    if (typeof body.backupS3Bucket === 'string') patch.backupS3Bucket = oneLine(body.backupS3Bucket, 200);
    if (typeof body.backupS3Prefix === 'string') patch.backupS3Prefix = oneLine(body.backupS3Prefix, 200);
    if (typeof body.backupS3Key === 'string') patch.backupS3Key = oneLine(body.backupS3Key, 200);
    if (typeof body.backupS3Secret === 'string') patch.backupS3Secret = String(body.backupS3Secret).slice(0, 200);
    return { patch };
  }

  return {
    DEFAULT_SETTINGS,
    getSettings,
    setSettings,
    setSettingsDurable,
    settingsForClient,
    computeSettingsPatch,
    effMaxUpload,
    updateCheckEnabled,
    publicIpDiscoveryEnabled,
  };
}

module.exports = { createSettingsService };
