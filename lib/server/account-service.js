'use strict';

const {
  hashPasswordSyncForStartup,
  parseHash,
} = require('../auth-utils');

const ACCOUNT_ROLES = new Set(['owner', 'admin', 'operator', 'auditor']);
const MAX_ACCOUNTS = 1000;
const DEFAULT_BOOTSTRAP_PASSWORD_TTL_MS = 15 * 60 * 1000;
const MIN_BOOTSTRAP_PASSWORD_TTL_MS = 5 * 60 * 1000;
const MAX_BOOTSTRAP_PASSWORD_TTL_MS = 60 * 60 * 1000;

/**
 * Owns Direct-Xfer's persisted administrator account model and first-run
 * bootstrap. Credential verification, lockouts and TOTP challenges remain in
 * auth-service; this service only resolves accounts and establishes the owner.
 *
 * Every lookup reads through getState() so a transactional restore may replace
 * the root state object without leaving account consumers attached to stale
 * data.
 */
function createAccountService(options = {}) {
  const {
    fs,
    path,
    crypto,
    dataDir,
    getState,
    getSettings,
    persistNow,
    env = process.env,
    passwordHasher = hashPasswordSyncForStartup,
    passwordParser = parseHash,
    now = Date.now,
    bootstrapPasswordTtlMs = DEFAULT_BOOTSTRAP_PASSWORD_TTL_MS,
    logger = console,
  } = options;

  for (const [name, dependency] of Object.entries({
    getState,
    getSettings,
    persistNow,
    passwordHasher,
    passwordParser,
    now,
  })) {
    if (typeof dependency !== 'function') throw new TypeError(`account-service requires ${name}()`);
  }
  if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.unlinkSync !== 'function') {
    throw new TypeError('account-service requires fs');
  }
  if (!path || typeof path.join !== 'function') throw new TypeError('account-service requires path');
  if (!crypto || typeof crypto.randomBytes !== 'function') throw new TypeError('account-service requires crypto');
  if (!dataDir) throw new TypeError('account-service requires dataDir');

  const requestedBootstrapTtl = Math.floor(Number(bootstrapPasswordTtlMs));
  const bootstrapPasswordLifetimeMs = Number.isFinite(requestedBootstrapTtl)
    ? Math.max(MIN_BOOTSTRAP_PASSWORD_TTL_MS, Math.min(MAX_BOOTSTRAP_PASSWORD_TTL_MS, requestedBootstrapTtl))
    : DEFAULT_BOOTSTRAP_PASSWORD_TTL_MS;

  const configuredAdminUsername = String(env.ADMIN_USERNAME || '').trim();
  let persistedOwnerUsername = '';
  if (!configuredAdminUsername) {
    // Preserve the already-persisted owner identity across upgrades/restarts. The
    // randomized fallback applies only to a genuinely fresh owner bootstrap; it
    // must never silently rename an existing legacy `admin` account.
    try {
      const bootstrapState = getState();
      const accounts = bootstrapState && bootstrapState.meta && Array.isArray(bootstrapState.meta.accounts)
        ? bootstrapState.meta.accounts
        : [];
      const existingOwner = accounts.find((account) => account && account.role === 'owner');
      if (existingOwner && typeof existingOwner.username === 'string') persistedOwnerUsername = existingOwner.username.trim();
    } catch (_) {}
  }
  // ASVS L3 requires default administrative accounts not to use a predictable
  // well-known identifier. A fresh deployment therefore receives a random owner
  // username unless ADMIN_USERNAME is explicitly configured. The username is
  // persisted with the account, so the random value is stable after bootstrap.
  const adminUsername = (
    configuredAdminUsername
    || persistedOwnerUsername
    || `owner-${crypto.randomBytes(6).toString('hex')}`
  ).slice(0, 40);
  if (!adminUsername || /[\u0000-\u001f\u007f]/.test(adminUsername)) {
    throw new TypeError('account-service requires a valid ADMIN_USERNAME');
  }
  const legacyPasswordFile = path.join(String(dataDir), 'admin-password.txt');
  const dummyPasswordRecord = passwordParser(passwordHasher(crypto.randomBytes(8).toString('hex')));
  if (!dummyPasswordRecord || !dummyPasswordRecord.salt || !dummyPasswordRecord.hash) {
    throw new TypeError('account-service could not create the dummy password record');
  }

  let initialized = false;
  let environmentOwnerHash = null;
  let environmentPasswordManaged = false;
  let initialPasswordFresh = false;
  let initialPasswordPlaintext = null;
  let initialPasswordExpiresAt = 0;

  function warn(prefix, error) {
    try { logger.warn(prefix, error && error.message ? error.message : error); } catch (_) {}
  }

  function info(message) {
    try { logger.log(message); } catch (_) {}
  }

  function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase().slice(0, 40);
  }

  function invalidAccountState(reason) {
    const error = new Error(`invalid-account-state:${reason}`);
    error.code = 'INVALID_ACCOUNT_STATE';
    return error;
  }

  function parsePasswordHash(value) {
    try { return passwordParser(value); }
    catch (_) { return null; }
  }

  function createPasswordHash(plaintext) {
    const stored = passwordHasher(plaintext);
    if (!parsePasswordHash(stored)) throw invalidAccountState('password-hash-failed');
    return stored;
  }

  function liveState() {
    const state = getState();
    if (!state || typeof state !== 'object') throw new TypeError('account-service requires a live state object');
    return state;
  }

  function accountList() {
    const state = liveState();
    return state.meta && Array.isArray(state.meta.accounts) ? state.meta.accounts : [];
  }

  function accountsFromMeta(meta) {
    if (Object.hasOwn(meta, 'accounts') && !Array.isArray(meta.accounts)) {
      throw invalidAccountState('accounts-not-array');
    }
    return Array.isArray(meta.accounts) ? meta.accounts : [];
  }

  function findAccountByName(username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    const accounts = accountList();
    if (environmentPasswordManaged && normalized === normalizeUsername(adminUsername)) {
      return accounts.find((account) => account && account.role === 'owner') || null;
    }
    return accounts.find((account) => account
      && !(environmentPasswordManaged && account.role === 'owner')
      && normalizeUsername(account.username) === normalized) || null;
  }

  function getAccountById(id) {
    return accountList().find((account) => account && account.id === id) || null;
  }

  function ownerAccount() {
    return accountList().find((account) => account && account.role === 'owner') || null;
  }

  function newAccountId() {
    return crypto.randomBytes(8).toString('hex');
  }

  function temporaryCredentialExpired(account) {
    if (!account || account.pwChanged) return false;
    const expiresAt = Number(account.bootstrapPasswordExpiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && now() >= expiresAt;
  }

  function accountPasswordRecord(account) {
    if (account && account === ownerAccount() && environmentPasswordManaged && environmentOwnerHash) {
      return environmentOwnerHash;
    }
    // A generated/bootstrap credential is only a short-lived enrollment secret.
    // Once its persisted deadline passes, verify against the normal dummy record so
    // callers keep indistinguishable password-work behavior without accepting it.
    if (temporaryCredentialExpired(account)) return dummyPasswordRecord;
    return parsePasswordHash(account && account.ah);
  }

  function accountNeedsPasswordChange(account) {
    if (!account) return false;
    if (account.role === 'owner' && environmentPasswordManaged) return false;
    return !account.pwChanged;
  }

  function readLegacyPassword() {
    try {
      const raw = fs.readFileSync(legacyPasswordFile, 'utf8').trim();
      return { exists:true, readable:true, value:raw || null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists:false, readable:true, value:null };
      warn('[accounts] could not read legacy admin-password.txt:', error);
      return { exists:true, readable:false, value:null };
    }
  }

  function removeLegacyPassword() {
    try {
      fs.unlinkSync(legacyPasswordFile);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      warn('[accounts] could not remove legacy admin-password.txt:', error);
      return false;
    }
  }

  function commitBootstrap() {
    try {
      return persistNow() === true;
    } catch (error) {
      warn('[accounts] could not persist account bootstrap:', error);
      return false;
    }
  }

  function inspectAccounts(accounts, options = {}) {
    if (!Array.isArray(accounts)) throw invalidAccountState('accounts-not-array');
    if (accounts.length > MAX_ACCOUNTS) throw invalidAccountState('too-many-accounts');

    const ids = new Set();
    const usernames = new Set();
    let owner = null;
    let ownerHashInvalid = false;
    for (const account of accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) {
        throw invalidAccountState('invalid-account-record');
      }
      const id = typeof account.id === 'string' ? account.id : '';
      if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
        throw invalidAccountState('invalid-account-id');
      }
      if (ids.has(id)) throw invalidAccountState('duplicate-account-id');
      ids.add(id);

      const rawUsername = typeof account.username === 'string' ? account.username.trim() : '';
      const username = normalizeUsername(rawUsername);
      if (!username || rawUsername.length > 40 || /[\u0000-\u001f\u007f]/.test(rawUsername)) {
        throw invalidAccountState('invalid-account-username');
      }
      if (usernames.has(username)) throw invalidAccountState('duplicate-account-username');
      usernames.add(username);

      if (!ACCOUNT_ROLES.has(account.role)) throw invalidAccountState('invalid-account-role');
      if (account.role === 'owner') {
        if (owner) throw invalidAccountState('multiple-owner-accounts');
        owner = account;
      }

      if (Object.hasOwn(account, 'bootstrapPasswordExpiresAt')) {
        const expiresAt = Number(account.bootstrapPasswordExpiresAt);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
          throw invalidAccountState('invalid-bootstrap-password-expiry');
        }
      }

      if (!parsePasswordHash(account.ah)) {
        if (account.role === 'owner' && environmentPasswordManaged && options.allowEnvOwnerRepair) {
          ownerHashInvalid = true;
        } else {
          throw invalidAccountState('invalid-account-password');
        }
      }
    }

    if (!owner && !options.allowMissingOwner) throw invalidAccountState('owner-missing');
    if (environmentPasswordManaged) {
      const environmentName = normalizeUsername(adminUsername);
      if (accounts.some((account) => account !== owner && normalizeUsername(account.username) === environmentName)) {
        throw invalidAccountState('environment-username-conflict');
      }
    }
    return { owner, ownerHashInvalid };
  }

  function storedLegacyHash(meta) {
    return parsePasswordHash(meta && meta.ah) ? meta.ah : null;
  }

  function placeholderPasswordHash() {
    return createPasswordHash(crypto.randomBytes(12).toString('base64url'));
  }

  function makeOwner(meta, settings, ownerHash, migrated) {
    return {
      id:newAccountId(),
      username:adminUsername,
      ah:ownerHash,
      role:'owner',
      totp:(meta.totp && meta.totp.secret) ? meta.totp : null,
      pwChanged:migrated ? !!(settings && settings.pwChanged) : false,
      createdAt:now(),
      createdBy:'system',
      lastLoginAt:0,
    };
  }

  function ensureEnvironmentOwnerHash(account) {
    if (!account || !environmentPasswordManaged || parsePasswordHash(account.ah)) return false;
    account.ah = placeholderPasswordHash();
    return true;
  }

  // Validates and prepares an isolated candidate root before transactional
  // restore replaces the live state. Old single-admin backups are migrated, but
  // a backup with no recoverable owner credential is rejected instead of
  // silently locking out the current administrator.
  function prepareRestoredState(candidate) {
    if (!candidate || typeof candidate !== 'object') throw invalidAccountState('state-not-object');
    if (!candidate.meta || typeof candidate.meta !== 'object' || Array.isArray(candidate.meta)) candidate.meta = {};
    const meta = candidate.meta;
    const accounts = accountsFromMeta(meta);
    const inspection = inspectAccounts(accounts, {
      allowMissingOwner:true,
      allowEnvOwnerRepair:true,
    });

    if (!inspection.owner) {
      if (accounts.length >= MAX_ACCOUNTS) throw invalidAccountState('too-many-accounts');
      const migratedHash = storedLegacyHash(meta);
      const ownerHash = migratedHash || (environmentPasswordManaged ? placeholderPasswordHash() : null);
      if (!ownerHash) throw invalidAccountState('owner-credential-missing');
      accounts.push(makeOwner(meta, candidate.settings, ownerHash, !!migratedHash));
      meta.accounts = accounts;
      delete meta.ah;
      delete meta.totp;
    } else {
      if (inspection.ownerHashInvalid) ensureEnvironmentOwnerHash(inspection.owner);
      if (!inspection.owner.totp && meta.totp && meta.totp.secret) inspection.owner.totp = meta.totp;
      delete meta.ah;
      delete meta.totp;
    }

    inspectAccounts(meta.accounts, { allowEnvOwnerRepair:false });
    return candidate;
  }

  // Idempotent for a process lifetime: a repeated call must not re-hash an
  // environment password or generate a second one-time owner credential.
  function initialize() {
    if (initialized) return bootstrapStatus();

    const state = liveState();
    if (state.meta == null) state.meta = {};
    else if (typeof state.meta !== 'object' || Array.isArray(state.meta)) throw invalidAccountState('meta-not-object');

    const fromEnvironment = String(env.ADMIN_PASSWORD || '').trim();
    if (fromEnvironment) {
      environmentOwnerHash = parsePasswordHash(createPasswordHash(fromEnvironment));
      environmentPasswordManaged = !!environmentOwnerHash;
      if (!environmentPasswordManaged) throw new Error('account-service could not hash ADMIN_PASSWORD');
    }

    const legacyPasswordFileState = readLegacyPassword();
    const legacyPassword = legacyPasswordFileState.value;
    const existingAccounts = accountsFromMeta(state.meta);
    const existingInspection = inspectAccounts(existingAccounts, {
      allowMissingOwner:true,
      allowEnvOwnerRepair:true,
    });
    if (existingInspection.owner) {
      let repaired = existingInspection.ownerHashInvalid
        ? ensureEnvironmentOwnerHash(existingInspection.owner)
        : false;
      // Upgrade old forced-change owner credentials into the same short-lived
      // enrollment model. Grant one bounded grace window from this startup rather
      // than expiring a legacy deployment immediately during upgrade.
      if (!environmentPasswordManaged
          && !existingInspection.owner.pwChanged
          && !Object.hasOwn(existingInspection.owner, 'bootstrapPasswordExpiresAt')) {
        existingInspection.owner.bootstrapPasswordExpiresAt = now() + bootstrapPasswordLifetimeMs;
        repaired = true;
      }
      if (!existingInspection.owner.totp && state.meta.totp && state.meta.totp.secret) {
        existingInspection.owner.totp = state.meta.totp;
        repaired = true;
      }
      if (Object.hasOwn(state.meta, 'ah')) { delete state.meta.ah; repaired = true; }
      if (Object.hasOwn(state.meta, 'totp')) { delete state.meta.totp; repaired = true; }
      inspectAccounts(existingAccounts, { allowEnvOwnerRepair:false });
      const durable = repaired ? commitBootstrap() : true;
      if ((!repaired || durable) && legacyPasswordFileState.exists && legacyPasswordFileState.readable) {
        removeLegacyPassword();
      }
      initialized = true;
      return { ...bootstrapStatus(), durable };
    }

    const legacyStoreHash = storedLegacyHash(state.meta);
    const fileLegacyHash = !legacyStoreHash && legacyPassword
      ? (parsePasswordHash(legacyPassword) ? legacyPassword : createPasswordHash(legacyPassword))
      : null;
    const migratedHash = legacyStoreHash || fileLegacyHash;
    let ownerHash = migratedHash;

    if (!ownerHash) {
      if (environmentPasswordManaged) {
        // The environment value is never persisted. Keep a random unusable
        // placeholder for the stored account while the override is active.
        ownerHash = placeholderPasswordHash();
      } else if (existingAccounts.length) {
        // Never silently mint a new owner over a non-empty but ownerless account
        // model: that would turn store corruption into an unexpected privilege.
        throw invalidAccountState('owner-credential-missing');
      } else {
        initialPasswordPlaintext = crypto.randomBytes(12).toString('base64url');
        ownerHash = createPasswordHash(initialPasswordPlaintext);
        initialPasswordFresh = true;
      }
    }

    const owner = makeOwner(state.meta, getSettings(), ownerHash, !!migratedHash);
    if (initialPasswordFresh) {
      initialPasswordExpiresAt = now() + bootstrapPasswordLifetimeMs;
      owner.bootstrapPasswordExpiresAt = initialPasswordExpiresAt;
    }

    if (existingAccounts.length >= MAX_ACCOUNTS) throw invalidAccountState('too-many-accounts');
    state.meta.accounts = existingAccounts.length ? [...existingAccounts, owner] : [owner];
    delete state.meta.ah;
    delete state.meta.totp;
    inspectAccounts(state.meta.accounts, { allowEnvOwnerRepair:false });
    const durable = commitBootstrap();

    // Never discard the only recoverable legacy credential until the new owner
    // account is durable. If deletion itself fails, the next startup retries it
    // after observing the persisted accounts model.
    if (legacyPasswordFileState.exists && legacyPasswordFileState.readable && durable) {
      const removed = removeLegacyPassword();
      if (removed && legacyPassword) {
        info('[config] migrated admin password into the data store; removed admin-password.txt.');
      }
    }

    initialized = true;
    return bootstrapStatus();
  }

  function purgeExpiredInitialPassword() {
    if (initialPasswordFresh && initialPasswordExpiresAt > 0 && now() >= initialPasswordExpiresAt) {
      initialPasswordFresh = false;
      initialPasswordPlaintext = null;
    }
  }

  function bootstrapStatus() {
    purgeExpiredInitialPassword();
    return {
      initialized,
      environmentManaged:environmentPasswordManaged,
      initialPasswordFresh:initialPasswordFresh && !!initialPasswordPlaintext,
      initialPasswordExpiresAt:initialPasswordFresh ? initialPasswordExpiresAt : 0,
      ownerAvailable:!!ownerAccount(),
    };
  }

  function isEnvironmentPasswordManaged() {
    return environmentPasswordManaged;
  }

  function ownerLoginUsername() {
    if (environmentPasswordManaged) return adminUsername;
    const owner = ownerAccount();
    return owner && owner.username ? owner.username : adminUsername;
  }

  function hasFreshInitialPassword() {
    purgeExpiredInitialPassword();
    return initialPasswordFresh && !!initialPasswordPlaintext;
  }

  function initialPassword() {
    return hasFreshInitialPassword() ? initialPasswordPlaintext : null;
  }

  function clearInitialPassword() {
    initialPasswordFresh = false;
    initialPasswordPlaintext = null;
  }

  return {
    adminUsername,
    dummyPasswordRecord,
    initialize,
    bootstrapStatus,
    normalizeUsername,
    accountList,
    findAccountByName,
    getAccountById,
    ownerAccount,
    newAccountId,
    accountPasswordRecord,
    accountNeedsPasswordChange,
    prepareRestoredState,
    isEnvironmentPasswordManaged,
    ownerLoginUsername,
    hasFreshInitialPassword,
    initialPassword,
    clearInitialPassword,
  };
}

module.exports = { createAccountService };