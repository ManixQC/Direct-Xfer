'use strict';

/**
 * Security/auth composition boundary for Direct-Xfer.
 *
 * Owns construction of the administrator session/CSRF and credential/TOTP
 * services, then composes visitor-facing access/anti-abuse services in a second
 * phase once the public page renderers exist. The underlying domain services
 * keep ownership of their runtime maps/secrets; this module only centralizes
 * dependency wiring and startup ordering.
 */
const { MAX_PASSWORD_CHARS, hashPassword, parseHash, verifyPassword } = require('../auth-utils');
const { createSessionService } = require('./session-service');
const { createAuthService } = require('./auth-service');
const { createPublicAccessService } = require('./public-access-service');
const { createPublicAbuseService } = require('./public-abuse-service');

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`security-auth application requires ${name}`);
  }
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`security-auth application requires ${name}()`);
  return value;
}

function createSecurityAuthApplication(options = {}) {
  const platform = requiredObject(options.platform, 'platform');
  const config = requiredObject(options.config, 'config');
  const request = requiredObject(options.request, 'request helpers');
  const state = requiredObject(options.state, 'state adapters');
  const account = requiredObject(options.account, 'account service');
  const pwa = requiredObject(options.pwa, 'PWA adapters');
  const network = requiredObject(options.network, 'network services');
  const notification = requiredObject(options.notification, 'notification adapters');
  const activity = requiredObject(options.activity, 'activity adapters');
  const share = requiredObject(options.share, 'share adapters');
  const utils = requiredObject(options.utils, 'core utilities');

  const crypto = requiredObject(platform.crypto, 'platform.crypto');
  const getSettings = requiredFunction(state.getSettings, 'state.getSettings');
  const scheduleFlush = requiredFunction(state.scheduleFlush, 'state.scheduleFlush');
  const persistNow = requiredFunction(state.persistNow, 'state.persistNow');
  const getAccountById = requiredFunction(account.getAccountById, 'account.getAccountById');
  const findAccountByName = requiredFunction(account.findAccountByName, 'account.findAccountByName');
  const accountPasswordRecord = requiredFunction(account.accountPasswordRecord, 'account.accountPasswordRecord');
  const normalizeUsername = requiredFunction(account.normalizeUsername, 'account.normalizeUsername');
  const clientIp = requiredFunction(request.clientIp, 'request.clientIp');
  const parseCookies = requiredFunction(request.parseCookies, 'request.parseCookies');
  const secureCookie = requiredFunction(request.secureCookie, 'request.secureCookie');
  const timingSafeEqualStr = requiredFunction(utils.timingSafeEqualStr, 'utils.timingSafeEqualStr');
  const closeStreamsForSession = requiredFunction(pwa.closeStreamsForSession, 'pwa.closeStreamsForSession');

  const sessionService = createSessionService({
    getSettings,
    defaultTtlMs:config.SESSION_TTL_MS,
    getAccountById,
    clientIp,
    parseCookies,
    secureCookie,
    timingSafeEqualStr,
    closeStreamsForSession,
  });

  const authService = createAuthService({
    getSettings,
    findAccountByName,
    getAccountById,
    accountPasswordRecord,
    dummyPasswordRecord:requiredObject(account.dummyPasswordRecord, 'account.dummyPasswordRecord'),
    normalizeUsername,
    clientIp,
    createSession:sessionService.createSession,
    scheduleFlush,
    persistNow,
    logAudit:requiredFunction(notification.logAudit, 'notification.logAudit'),
    getPwaDevice:requiredFunction(pwa.getPwaDevice, 'pwa.getPwaDevice'),
    pwaDeviceResolvedAccount:requiredFunction(pwa.pwaDeviceResolvedAccount, 'pwa.pwaDeviceResolvedAccount'),
    geoSync:requiredFunction(network.geoSync, 'network.geoSync'),
    geolocate:requiredFunction(network.geolocate, 'network.geolocate'),
    addCenterNotification:requiredFunction(notification.addCenterNotification, 'notification.addCenterNotification'),
    enrichCenterNotificationGeo:requiredFunction(notification.enrichCenterNotificationGeo, 'notification.enrichCenterNotificationGeo'),
    publicIp:requiredFunction(activity.publicIp, 'activity.publicIp'),
    flagFromCode:requiredFunction(utils.flagFromCode, 'utils.flagFromCode'),
    failWindowMs:config.FAIL_WINDOW_MS,
  });

  let publicSecurity = null;
  let publicSecurityPhase = 'idle';
  let publicSecurityFailure = null;

  function initializePublicSecurity(init = {}) {
    if (publicSecurityPhase === 'ready') return publicSecurity;
    if (publicSecurityPhase === 'initializing') {
      throw new Error('security-auth public security initialization is already in progress');
    }
    if (publicSecurityPhase === 'failed') {
      const error = new Error('security-auth public security initialization previously failed; restart is required');
      if (publicSecurityFailure) error.cause = publicSecurityFailure;
      throw error;
    }

    const pages = requiredObject(init.pages, 'public pages');
    const errorPage = requiredFunction(pages.errorPage, 'public pages.errorPage');
    const pickLang = requiredFunction(pages.pickLang, 'public pages.pickLang');
    const challengePage = requiredFunction(pages.challengePage, 'public pages.challengePage');
    const linkPrefix = requiredFunction(share.linkPrefix, 'share.linkPrefix');
    const isLoopback = requiredFunction(utils.isLoopback, 'utils.isLoopback');
    const isPrivateIp = requiredFunction(utils.isPrivateIp, 'utils.isPrivateIp');
    const parseIpList = requiredFunction(utils.parseIpList, 'utils.parseIpList');
    const ipInList = requiredFunction(utils.ipInList, 'utils.ipInList');
    const maskIp = requiredFunction(activity.maskIp, 'activity.maskIp');
    const pruneLeakTrackers = requiredFunction(notification.pruneLeakTrackers, 'notification.pruneLeakTrackers');

    publicSecurityPhase = 'initializing';
    let publicAbuseService = null;
    try {
      const publicAccessService = createPublicAccessService({
        crypto,
        clientIp,
        geoSync:network.geoSync,
        geolocate:network.geolocate,
        hashPassword,
        parseHash,
        verifyPassword,
        parseCookies,
        secureCookie,
        timingSafeEqualStr,
        linkPrefix,
        isLoopback,
        isPrivateIp,
        parseIpList,
        ipInList,
        errorPage,
        pickLang,
        maxPasswordChars:MAX_PASSWORD_CHARS,
        failWindowMs:config.FAIL_WINDOW_MS,
        unlockMaxFails:8,
      });

      publicAbuseService = createPublicAbuseService({
        crypto,
        clientIp,
        getSettings,
        maskIp,
        parseCookies,
        secureCookie,
        timingSafeEqualStr,
        challengePage,
        pickLang,
        pruneLeakTrackers,
      });

      publicSecurity = Object.freeze({ publicAccessService, publicAbuseService });
      publicSecurityFailure = null;
      publicSecurityPhase = 'ready';
      return publicSecurity;
    } catch (error) {
      if (publicAbuseService && typeof publicAbuseService.close === 'function') {
        try { publicAbuseService.close(); } catch (_) {}
      }
      publicSecurity = null;
      publicSecurityFailure = error;
      publicSecurityPhase = 'failed';
      throw error;
    }
  }

  function getPublicSecurity() {
    if (publicSecurityPhase !== 'ready' || !publicSecurity) {
      throw new Error('security-auth public security is not initialized yet');
    }
    return publicSecurity;
  }

  function isBusyForStateReplacement() {
    if (typeof authService.isBusyForStateReplacement === 'function'
        && authService.isBusyForStateReplacement()) return true;
    if (publicSecurityPhase === 'ready' && publicSecurity
        && publicSecurity.publicAccessService
        && typeof publicSecurity.publicAccessService.isBusyForStateReplacement === 'function'
        && publicSecurity.publicAccessService.isBusyForStateReplacement()) return true;
    return false;
  }

  function clearRuntimeState() {
    sessionService.clearAllSessions();
    if (typeof authService.clearRuntimeState === 'function') authService.clearRuntimeState();
    if (publicSecurityPhase === 'ready' && publicSecurity) {
      if (publicSecurity.publicAccessService
          && typeof publicSecurity.publicAccessService.clearRuntimeState === 'function') {
        publicSecurity.publicAccessService.clearRuntimeState();
      }
      if (publicSecurity.publicAbuseService
          && typeof publicSecurity.publicAbuseService.clearRuntimeState === 'function') {
        publicSecurity.publicAbuseService.clearRuntimeState();
      }
    }
  }

  return Object.freeze({
    sessionService,
    authService,
    initializePublicSecurity,
    getPublicSecurity,
    isBusyForStateReplacement,
    clearRuntimeState,
  });
}

module.exports = { createSecurityAuthApplication };
