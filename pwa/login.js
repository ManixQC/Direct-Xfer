'use strict';
(function () {
  var STRINGS = {
    fr: {
      mobile: 'Administration mobile', title: 'Connexion administrateur',
      subtitle: "Connectez-vous pour ouvrir l’application d’envoi mobile.",
      username: "Nom d’utilisateur", password: 'Mot de passe',
      rememberUsername: "Se souvenir du nom d’utilisateur", rememberPassword: 'Se souvenir du mot de passe',
      rememberPasswordHint: 'Le mot de passe est chiffré dans ce navigateur uniquement lorsque cette case est cochée.',
      pullToRefresh: 'Glissez vers le bas pour actualiser', releaseToRefresh: 'Relâchez pour actualiser', refreshing: 'Actualisation…',
      totp: 'Code de double authentification',
      totpHint: 'Entrez le code à 6 chiffres ou un code de récupération.',
      submit: 'Se connecter', signingIn: 'Connexion…', language: 'Langue',
      fullAdmin: 'Version administrateur complète', invalid: 'Identifiants incorrects.',
      totpRequired: 'Entrez votre code de double authentification.',
      totpInvalid: 'Le code de double authentification est invalide.',
      locked: 'Trop de tentatives. Réessayez dans {seconds} secondes.',
      network: 'Impossible de joindre Direct-Xfer.', denied: 'Accès administrateur non autorisé depuis ce réseau.', installWarningTitle: 'Installation complète indisponible', installHttpsRequired: 'Android ne peut installer Direct-Xfer comme application que depuis une adresse HTTPS avec un certificat reconnu. En HTTP, seul un raccourci est créé.', installOpenHttps: 'Ouvrir l’adresse HTTPS', install: 'Installer', installPending: 'Installation en préparation. Touchez la page et gardez-la ouverte quelques instants, puis réessayez.', installBrowserHint: 'Chrome prépare encore l’installation complète. Gardez cette page ouverte quelques instants, puis touchez de nouveau le logo Installer.', installIosHint: 'Touchez Partager, puis « Sur l’écran d’accueil ».'
    },
    en: {
      mobile: 'Mobile administration', title: 'Administrator sign-in',
      subtitle: 'Sign in to open the mobile sending application.',
      username: 'Username', password: 'Password',
      rememberUsername: 'Remember username', rememberPassword: 'Remember password',
      rememberPasswordHint: 'The password is encrypted in this browser only when this option is selected.',
      pullToRefresh: 'Pull down to refresh', releaseToRefresh: 'Release to refresh', refreshing: 'Refreshing…',
      totp: 'Two-factor authentication code',
      totpHint: 'Enter the 6-digit code or a recovery code.', submit: 'Sign in', signingIn: 'Signing in…',
      language: 'Language', fullAdmin: 'Full administrator version', invalid: 'Incorrect credentials.',
      totpRequired: 'Enter your two-factor authentication code.', totpInvalid: 'The two-factor authentication code is invalid.',
      locked: 'Too many attempts. Try again in {seconds} seconds.', network: 'Unable to reach Direct-Xfer.',
      denied: 'Administrator access is not allowed from this network.', installWarningTitle: 'Full installation unavailable', installHttpsRequired: 'Android can install Direct-Xfer as an app only from an HTTPS address with a trusted certificate. HTTP creates only a shortcut.', installOpenHttps: 'Open HTTPS address', install: 'Install', installPending: 'Installation is being prepared. Interact with the page, keep it open briefly, then try again.', installBrowserHint: 'Chrome is still preparing full installation. Keep this page open briefly, then tap the Install logo again.', installIosHint: 'Tap Share, then “Add to Home Screen”.'
    },
    es: {
      mobile: 'Administración móvil', title: 'Inicio de sesión administrador',
      subtitle: 'Inicia sesión para abrir la aplicación móvil de envío.',
      username: 'Usuario', password: 'Contraseña',
      rememberUsername: 'Recordar el nombre de usuario', rememberPassword: 'Recordar la contraseña',
      rememberPasswordHint: 'La contraseña se cifra en este navegador solo cuando esta opción está seleccionada.',
      pullToRefresh: 'Desliza hacia abajo para actualizar', releaseToRefresh: 'Suelta para actualizar', refreshing: 'Actualizando…',
      totp: 'Código de autenticación de dos factores',
      totpHint: 'Introduce el código de 6 dígitos o un código de recuperación.', submit: 'Iniciar sesión', signingIn: 'Iniciando…',
      language: 'Idioma', fullAdmin: 'Versión completa de administración', invalid: 'Credenciales incorrectas.',
      totpRequired: 'Introduce el código de autenticación de dos factores.', totpInvalid: 'El código de autenticación de dos factores no es válido.',
      locked: 'Demasiados intentos. Vuelve a intentarlo en {seconds} segundos.', network: 'No se puede conectar con Direct-Xfer.',
      denied: 'El acceso de administración no está permitido desde esta red.', installWarningTitle: 'Instalación completa no disponible', installHttpsRequired: 'Android solo puede instalar Direct-Xfer como aplicación desde una dirección HTTPS con un certificado confiable. HTTP crea únicamente un acceso directo.', installOpenHttps: 'Abrir dirección HTTPS', install: 'Instalar', installPending: 'La instalación se está preparando. Interactúa con la página, mantenla abierta unos instantes y vuelve a intentarlo.', installBrowserHint: 'Chrome todavía está preparando la instalación completa. Mantén la página abierta unos instantes y vuelve a tocar el logotipo Instalar.', installIosHint: 'Toca Compartir y luego «Añadir a pantalla de inicio».'
    }
  };
  var form = document.getElementById('mobile-login-form');
  var user = document.getElementById('mobile-username');
  var password = document.getElementById('mobile-password');
  var totp = document.getElementById('mobile-totp');
  var totpRow = document.getElementById('mobile-totp-row');
  var submit = document.getElementById('mobile-login-submit');
  var error = document.getElementById('mobile-login-error');
  var language = document.getElementById('mobile-language');
  var rememberUsername = document.getElementById('mobile-remember-username');
  var rememberPassword = document.getElementById('mobile-remember-password');
  var pullRefresh = document.getElementById('mobile-pull-refresh');
  var installWarning = document.getElementById('mobile-install-warning');
  var installWarningText = document.getElementById('mobile-install-warning-text');
  var installHttpsLink = document.getElementById('mobile-install-https-link');
  var installButton = document.getElementById('mobile-install-btn');
  var deferredInstallPrompt = null;
  var lang = 'fr';
  var LOGIN_KEYS = { rememberUsername: 'dx-login-remember-username', rememberPassword: 'dx-login-remember-password', username: 'dx-login-username' };

  function safeNext() {
    var value = new URLSearchParams(location.search).get('next') || '/app/';
    if (!/^\/app(?:\/|\?|$)/.test(value) || value.indexOf('//') === 0 || /[\r\n]/.test(value)) return '/app/';
    return value === '/app' ? '/app/' : value;
  }
  function message(key, vars) {
    var text = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.fr[key] || key;
    Object.keys(vars || {}).forEach(function (name) { text = text.replace('{' + name + '}', String(vars[name])); });
    return text;
  }
  function applyLanguage(nextLang) {
    lang = STRINGS[nextLang] ? nextLang : 'fr';
    document.documentElement.lang = lang;
    language.value = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (STRINGS[lang][key]) node.textContent = STRINGS[lang][key];
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-title');
      if (STRINGS[lang][key]) node.title = STRINGS[lang][key];
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-aria');
      if (STRINGS[lang][key]) node.setAttribute('aria-label', STRINGS[lang][key]);
    });
    if (!submit.disabled) submit.textContent = message('submit');
    try { localStorage.setItem('dx-pwa-lang', lang); } catch (_) {}
  }
  function showError(text) {
    error.textContent = text;
    error.classList.toggle('hidden', !text);
  }
  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = message(busy ? 'signingIn' : 'submit');
  }
  function showTotp(text) {
    totpRow.classList.remove('hidden');
    showError(text);
    totp.focus();
  }
  function storageGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function storageRemove(key) { try { localStorage.removeItem(key); } catch (_) {} }
  var mobilePasswordUnlocked = false;
  function unlockMobilePasswordField() {
    if (mobilePasswordUnlocked) return;
    mobilePasswordUnlocked = true;
    password.readOnly = false;
    password.setAttribute('autocomplete', 'off');
  }
  function lockMobilePasswordField() {
    mobilePasswordUnlocked = false;
    password.value = '';
    password.readOnly = true;
    password.setAttribute('autocomplete', 'off');
  }
  async function hydrateRememberedLogin() {
    var legacy = storageGet('dxuser') || '';
    var rememberUser = storageGet(LOGIN_KEYS.rememberUsername) === '1' || (!!legacy && storageGet(LOGIN_KEYS.rememberUsername) == null);
    var rememberPass = storageGet(LOGIN_KEYS.rememberPassword) === '1';
    rememberUsername.checked = rememberUser;
    rememberPassword.checked = rememberPass;
    if (rememberUser) user.value = storageGet(LOGIN_KEYS.username) || legacy;
    if (!rememberPass) {
      lockMobilePasswordField();
      if (window.DXLoginVault) { try { await window.DXLoginVault.clear(); } catch (_) {} }
      return;
    }
    unlockMobilePasswordField();
    if (window.DXLoginVault) {
      try {
        var saved = await window.DXLoginVault.load();
        if (saved) {
          if (saved.username) user.value = saved.username;
          if (saved.password) password.value = saved.password;
        }
      } catch (_) {}
    }
  }
  async function persistRememberedLogin(username, secret, allowPasswordStore) {
    var keepUser = rememberUsername.checked;
    var keepPassword = rememberPassword.checked && allowPasswordStore;
    storageSet(LOGIN_KEYS.rememberUsername, keepUser ? '1' : '0');
    storageSet(LOGIN_KEYS.rememberPassword, keepPassword ? '1' : '0');
    if (keepUser || keepPassword) {
      storageSet(LOGIN_KEYS.username, username);
      storageSet('dxuser', username);
    } else {
      storageRemove(LOGIN_KEYS.username);
      storageRemove('dxuser');
    }
    if (window.DXLoginVault) {
      try {
        if (keepPassword) await window.DXLoginVault.save(username, secret);
        else await window.DXLoginVault.clear();
      } catch (_) {}
    }
  }
  function installPullToRefresh() {
    if (!pullRefresh || !('ontouchstart' in window)) return;
    var startY = 0, distance = 0, tracking = false;
    var threshold = 86, maxDistance = 145;
    var text = pullRefresh.querySelector('.pull-refresh-text');
    function atTop() { return (document.scrollingElement ? document.scrollingElement.scrollTop : window.scrollY) <= 0; }
    function reset() {
      tracking = false; distance = 0;
      pullRefresh.classList.remove('visible', 'ready', 'refreshing');
      pullRefresh.style.setProperty('--pull-distance', '0px');
      pullRefresh.setAttribute('aria-hidden', 'true');
      if (text) text.textContent = message('pullToRefresh');
    }
    document.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1 || !atTop() || event.target.closest('input, select, button, textarea, a')) return;
      startY = event.touches[0].clientY; distance = 0; tracking = true;
    }, { passive: true });
    document.addEventListener('touchmove', function (event) {
      if (!tracking || event.touches.length !== 1) return;
      var raw = event.touches[0].clientY - startY;
      if (raw <= 0 || !atTop()) { reset(); return; }
      distance = Math.min(maxDistance, raw * .62);
      if (distance < 7) return;
      event.preventDefault();
      pullRefresh.classList.add('visible');
      pullRefresh.classList.toggle('ready', distance >= threshold);
      pullRefresh.style.setProperty('--pull-distance', distance + 'px');
      pullRefresh.setAttribute('aria-hidden', 'false');
      if (text) text.textContent = message(distance >= threshold ? 'releaseToRefresh' : 'pullToRefresh');
    }, { passive: false });
    document.addEventListener('touchend', function () {
      if (!tracking) return;
      var shouldRefresh = distance >= threshold;
      tracking = false;
      if (!shouldRefresh) { reset(); return; }
      pullRefresh.classList.add('refreshing');
      pullRefresh.classList.remove('ready');
      pullRefresh.style.setProperty('--pull-distance', '92px');
      if (text) text.textContent = message('refreshing');
      setTimeout(function () { location.reload(); }, 180);
    }, { passive: true });
    document.addEventListener('touchcancel', reset, { passive: true });
  }

  rememberPassword.addEventListener('change', async function () {
    storageSet(LOGIN_KEYS.rememberPassword, rememberPassword.checked ? '1' : '0');
    if (rememberPassword.checked) {
      rememberUsername.checked = true;
      storageSet(LOGIN_KEYS.rememberUsername, '1');
    } else {
      if (window.DXLoginVault) { try { await window.DXLoginVault.clear(); } catch (_) {} }
      lockMobilePasswordField();
    }
  });
  rememberUsername.addEventListener('change', async function () {
    storageSet(LOGIN_KEYS.rememberUsername, rememberUsername.checked ? '1' : '0');
    if (!rememberUsername.checked) {
      rememberPassword.checked = false;
      storageSet(LOGIN_KEYS.rememberPassword, '0');
      storageRemove(LOGIN_KEYS.username);
      storageRemove('dxuser');
      if (window.DXLoginVault) { try { await window.DXLoginVault.clear(); } catch (_) {} }
      lockMobilePasswordField();
    }
  });
  ['pointerdown', 'touchstart', 'focus', 'keydown'].forEach(function (eventName) {
    password.addEventListener(eventName, unlockMobilePasswordField, { passive: eventName !== 'keydown' });
  });
  language.addEventListener('change', function () { applyLanguage(language.value); });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    showError('');
    unlockMobilePasswordField();
    if (!user.value.trim() || !password.value) {
      showError(message('invalid'));
      (!user.value.trim() ? user : password).focus();
      return;
    }
    setBusy(true);
    try {
      var platform = navigator.userAgentData && navigator.userAgentData.platform
        ? navigator.userAgentData.platform : (navigator.platform || 'Appareil mobile');
      var response = await fetch('/app/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: user.value.trim(), password: password.value, totp: totp.value.trim(),
          deviceName: 'Direct-Xfer PWA · ' + String(platform).slice(0, 60)
        })
      });
      var data = await response.json().catch(function () { return {}; });
      if (response.ok && data.ok) {
        await persistRememberedLogin(user.value.trim(), password.value, !data.mustChangePassword);
        if (data.mustChangePassword) {
          location.replace('/?next=' + encodeURIComponent(safeNext()));
        } else {
          location.replace(safeNext());
        }
        return;
      }
      if (response.status === 403 && data.error === 'admin-lan-only') showError(message('denied'));
      else if (data.error === 'totp-required') showTotp(message('totpRequired'));
      else if (data.error === 'invalid-totp') showTotp(message('totpInvalid'));
      else if (data.error === 'too-many-attempts') showError(message('locked', { seconds: data.retryAfter || 60 }));
      else showError(message('invalid'));
    } catch (_) {
      showError(message('network'));
    } finally {
      setBusy(false);
    }
  });

  function isStandaloneApp() {
    try {
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        !!navigator.standalone || document.referrer.indexOf('android-app://') === 0;
    } catch (_) { return false; }
  }
  function isIosBrowser() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1);
  }
  function isMobileLike() {
    try {
      return !!(navigator.userAgentData && navigator.userAgentData.mobile) ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
        (navigator.maxTouchPoints > 1 && Math.min(screen.width || innerWidth, screen.height || innerHeight) < 1100);
    } catch (_) { return true; }
  }
  function isInstallSecureOrigin() {
    if (window.isSecureContext && location.protocol === 'https:') return true;
    var host = String(location.hostname || '').toLowerCase();
    return !!window.isSecureContext && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  }
  function updateMobileInstallButton() {
    if (!installButton) return;
    var show = !isStandaloneApp() && isMobileLike() && isInstallSecureOrigin();
    installButton.classList.toggle('hidden', !show);
    installButton.classList.toggle('install-pending', show && !deferredInstallPrompt && !isIosBrowser());
  }
  async function showInstallabilityWarning(key) {
    if (!installWarning) return;
    installWarning.classList.remove('hidden');
    if (installWarningText) installWarningText.textContent = message(key || 'installHttpsRequired');
    if (!isInstallSecureOrigin()) {
      try {
        var response = await fetch('/app/install-info', { credentials: 'same-origin', cache: 'no-store' });
        var info = response.ok ? await response.json() : null;
        if (installHttpsLink && info && info.httpsUrl) {
          installHttpsLink.href = info.httpsUrl;
          installHttpsLink.classList.remove('hidden');
        }
      } catch (_) {}
    } else if (installHttpsLink) {
      installHttpsLink.classList.add('hidden');
    }
  }
  async function requestMobileInstall() {
    if (deferredInstallPrompt) {
      var promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      try { await promptEvent.prompt(); await promptEvent.userChoice; } catch (_) {}
      updateMobileInstallButton();
      return;
    }
    if (isIosBrowser()) { alert(message('installIosHint')); return; }
    if (!isInstallSecureOrigin()) { showInstallabilityWarning('installHttpsRequired'); return; }
    showInstallabilityWarning('installPending');
    alert(message('installBrowserHint'));
  }

  var saved = '';
  try { saved = localStorage.getItem('dx-pwa-lang') || ''; } catch (_) {}
  if (!STRINGS[saved]) {
    var browser = String(navigator.language || '').slice(0, 2).toLowerCase();
    saved = STRINGS[browser] ? browser : 'fr';
  }
  applyLanguage(saved);
  installPullToRefresh();
  if (!isInstallSecureOrigin()) showInstallabilityWarning('installHttpsRequired');
  updateMobileInstallButton();
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installWarning) installWarning.classList.add('hidden');
    updateMobileInstallButton();
  });
  window.addEventListener('appinstalled', function () {
    deferredInstallPrompt = null;
    if (installWarning) installWarning.classList.add('hidden');
    updateMobileInstallButton();
  });
  if (installButton) installButton.addEventListener('click', requestMobileInstall);
  // Register the PWA worker on the mobile login page too. This prevents Android
  // from creating a simple home-screen shortcut with no WebAPK/share-target
  // integration when the user installs before signing in.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/direct-xfer-pwa-sw.js?v=104', { scope: '/app/' }).catch(function () {});
  }
  hydrateRememberedLogin().finally(function () { ((rememberPassword.checked && password.value) ? password : user).focus(); });
})();
