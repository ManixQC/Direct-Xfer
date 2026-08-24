'use strict';
(() => {
  const title = document.getElementById('oauth-bridge-title');
  const status = document.getElementById('oauth-bridge-status');
  const help = document.getElementById('oauth-bridge-help');
  const closeBtn = document.getElementById('oauth-bridge-close');
  const card = document.querySelector('.oauth-bridge-card');
  const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  let sessionId = String(params.get('session') || '').trim();
  const pendingSession = params.get('pending') === '1';
  const provider = String(params.get('provider') || 'OAuth').trim();
  const langRaw = String(params.get('lang') || navigator.language || 'en').toLowerCase();
  const lang = langRaw.startsWith('fr') ? 'fr' : (langRaw.startsWith('es') ? 'es' : 'en');
  const copy = {
    fr: {
      title: `Connexion à ${provider}`,
      preparing: 'Direct-Xfer prépare la page d’autorisation…',
      redirecting: `Ouverture de ${provider}…`,
      help: 'Cet onglet se redirigera automatiquement dès que le fournisseur sera prêt.',
      failed: 'La connexion OAuth n’a pas pu démarrer.',
      completed: 'La connexion OAuth est terminée.',
      completedHelp: 'Vous pouvez fermer cet onglet et revenir à Direct-Xfer.',
      expired: 'La session Direct-Xfer a expiré. Revenez à Direct-Xfer, reconnectez-vous puis réessayez.',
      retry: 'Revenez à l’onglet Direct-Xfer et cliquez sur « Réessayer ».',
      invalid: 'La page de connexion reçue n’est pas valide.',
      close: 'Fermer cet onglet'
    },
    en: {
      title: `Connect to ${provider}`,
      preparing: 'Direct-Xfer is preparing the authorization page…',
      redirecting: `Opening ${provider}…`,
      help: 'This tab will redirect automatically as soon as the provider is ready.',
      failed: 'OAuth sign-in could not be started.',
      completed: 'OAuth sign-in is complete.',
      completedHelp: 'You can close this tab and return to Direct-Xfer.',
      expired: 'Your Direct-Xfer session expired. Return to Direct-Xfer, sign in again, then retry.',
      retry: 'Return to the Direct-Xfer tab and click “Retry”.',
      invalid: 'The received sign-in URL is invalid.',
      close: 'Close this tab'
    },
    es: {
      title: `Conectar con ${provider}`,
      preparing: 'Direct-Xfer está preparando la página de autorización…',
      redirecting: `Abriendo ${provider}…`,
      help: 'Esta pestaña se redirigirá automáticamente cuando el proveedor esté listo.',
      failed: 'No se pudo iniciar la conexión OAuth.',
      completed: 'La conexión OAuth ha terminado.',
      completedHelp: 'Puedes cerrar esta pestaña y volver a Direct-Xfer.',
      expired: 'La sesión de Direct-Xfer caducó. Vuelve a Direct-Xfer, inicia sesión y reintenta.',
      retry: 'Vuelve a la pestaña Direct-Xfer y pulsa «Reintentar».',
      invalid: 'La URL de inicio de sesión recibida no es válida.',
      close: 'Cerrar esta pestaña'
    }
  }[lang];

  document.documentElement.lang = lang;
  document.title = `Direct-Xfer — ${provider}`;
  title.textContent = copy.title;
  status.textContent = copy.preparing;
  help.textContent = copy.help;
  closeBtn.textContent = copy.close;
  closeBtn.addEventListener('click', () => window.close());

  let stopped = false;
  let timer = null;
  let failures = 0;
  let waitingForSession = pendingSession && !sessionId;

  function fail(message, detail) {
    stopped = true;
    if (timer) clearTimeout(timer);
    card.classList.add('error');
    status.textContent = message || copy.failed;
    help.textContent = detail || copy.retry;
    closeBtn.classList.remove('hidden');
  }

  function oauthErrorDetail(code) {
    const key = String(code || '').trim().toLowerCase();
    const messages = {
      fr: {
        'rclone-unavailable': 'Le composant rclone est indisponible. Activez ou réinstallez rclone dans les composants optionnels, puis réessayez.',
        'oauth-loopback-port-unavailable': 'Le port OAuth local 53682 est déjà utilisé sur la machine Direct-Xfer. Fermez l’autre processus rclone/OAuth puis réessayez.',
        'oauth-invalid-client': 'Google a refusé le Client ID ou le Client Secret. Vérifiez les identifiants OAuth Google configurés dans Direct-Xfer.',
        'oauth-access-denied': 'L’autorisation a été refusée ou annulée dans le navigateur. Revenez à Direct-Xfer et réessayez.',
        'oauth-token-exchange-failed': 'Google a accepté l’autorisation, mais rclone n’a pas pu échanger le code contre un jeton. Vérifiez le Client ID/Secret puis réessayez.',
        'oauth-provider-unreachable': 'La machine Direct-Xfer n’arrive pas à joindre le fournisseur OAuth. Vérifiez son accès Internet/DNS puis réessayez.',
        'oauth-local-auth-unreachable': 'Direct-Xfer n’arrive pas à joindre le listener OAuth local de rclone. Réessayez; si le problème persiste, vérifiez le pare-feu local.',
        'oauth-local-auth-timeout': 'Le listener OAuth local de rclone n’a pas répondu à temps. Réessayez.',
        'oauth-provider-url-missing': 'rclone a démarré OAuth mais n’a pas fourni de redirection valide vers Google. Réessayez avec rclone à jour.',
        'oauth-state-missing': 'rclone a renvoyé une session OAuth invalide (state manquant). Réessayez.',
        'oauth-state-mismatch': 'La session OAuth retournée par rclone ne correspond pas à la tentative en cours. Réessayez.',
        'connector-config-error': 'rclone a refusé de poursuivre la configuration du remote. Revenez à Direct-Xfer et cliquez sur « Réessayer ».',
        'connector-response': 'Direct-Xfer a reçu une réponse de configuration rclone invalide. Vérifiez que rclone est à jour puis réessayez.',
        'oauth-failed': 'rclone a interrompu le démarrage OAuth. Revenez à Direct-Xfer et cliquez sur « Réessayer ».',
      },
      en: {
        'rclone-unavailable': 'The rclone component is unavailable. Enable or reinstall rclone in Optional components, then retry.',
        'oauth-loopback-port-unavailable': 'Local OAuth port 53682 is already in use on the Direct-Xfer machine. Close the other rclone/OAuth process and retry.',
        'oauth-invalid-client': 'Google rejected the Client ID or Client Secret. Check the Google OAuth credentials configured in Direct-Xfer.',
        'oauth-access-denied': 'Authorization was denied or cancelled in the browser. Return to Direct-Xfer and retry.',
        'oauth-token-exchange-failed': 'Google accepted authorization, but rclone could not exchange the code for a token. Check the Client ID/Secret and retry.',
        'oauth-provider-unreachable': 'The Direct-Xfer machine cannot reach the OAuth provider. Check its Internet/DNS access and retry.',
        'oauth-local-auth-unreachable': 'Direct-Xfer cannot reach rclone’s local OAuth listener. Retry and check the local firewall if it persists.',
        'oauth-local-auth-timeout': 'rclone’s local OAuth listener did not respond in time. Retry.',
        'oauth-provider-url-missing': 'rclone started OAuth but did not provide a valid provider redirect. Retry with an up-to-date rclone.',
        'oauth-state-missing': 'rclone returned an invalid OAuth session (missing state). Retry.',
        'oauth-state-mismatch': 'The OAuth session returned by rclone does not match the current attempt. Retry.',
        'connector-config-error': 'rclone refused to continue configuring the remote. Return to Direct-Xfer and click “Retry”.',
        'connector-response': 'Direct-Xfer received an invalid rclone configuration response. Make sure rclone is up to date and retry.',
        'oauth-failed': 'rclone stopped while starting OAuth. Return to Direct-Xfer and click “Retry”.',
      },
      es: {
        'rclone-unavailable': 'El componente rclone no está disponible. Actívalo o reinstálalo en Componentes opcionales y vuelve a intentarlo.',
        'oauth-loopback-port-unavailable': 'El puerto OAuth local 53682 ya está en uso en la máquina Direct-Xfer. Cierra el otro proceso rclone/OAuth y vuelve a intentarlo.',
        'oauth-invalid-client': 'Google rechazó el Client ID o Client Secret. Comprueba las credenciales OAuth de Google configuradas en Direct-Xfer.',
        'oauth-access-denied': 'La autorización fue rechazada o cancelada en el navegador. Vuelve a Direct-Xfer e inténtalo de nuevo.',
        'oauth-token-exchange-failed': 'Google aceptó la autorización, pero rclone no pudo cambiar el código por un token. Comprueba el Client ID/Secret y reintenta.',
        'oauth-provider-unreachable': 'La máquina Direct-Xfer no puede acceder al proveedor OAuth. Comprueba Internet/DNS y vuelve a intentarlo.',
        'oauth-local-auth-unreachable': 'Direct-Xfer no puede acceder al listener OAuth local de rclone. Reintenta y comprueba el firewall local si persiste.',
        'oauth-local-auth-timeout': 'El listener OAuth local de rclone no respondió a tiempo. Vuelve a intentarlo.',
        'oauth-provider-url-missing': 'rclone inició OAuth pero no proporcionó una redirección válida al proveedor. Actualiza rclone y vuelve a intentarlo.',
        'oauth-state-missing': 'rclone devolvió una sesión OAuth inválida (falta state). Vuelve a intentarlo.',
        'oauth-state-mismatch': 'La sesión OAuth devuelta por rclone no coincide con el intento actual. Vuelve a intentarlo.',
        'connector-config-error': 'rclone rechazó continuar la configuración del remote. Vuelve a Direct-Xfer y pulsa «Reintentar».',
        'connector-response': 'Direct-Xfer recibió una respuesta de configuración rclone inválida. Actualiza rclone y vuelve a intentarlo.',
        'oauth-failed': 'rclone se detuvo al iniciar OAuth. Vuelve a Direct-Xfer y pulsa «Reintentar».',
      }
    };
    const localized = messages[lang] || messages.en;
    if (localized[key]) return localized[key];
    if (/^[a-z0-9._-]{1,120}$/i.test(key)) {
      const prefix = lang === 'fr' ? 'Erreur rclone/Direct-Xfer : ' : (lang === 'es' ? 'Error rclone/Direct-Xfer: ' : 'rclone/Direct-Xfer error: ');
      return `${prefix}${key}`;
    }
    return copy.retry;
  }

  function go(url) {
    if (stopped || !url) return;
    const value = String(url).trim();
    if (!value.startsWith('https://')) { fail(copy.invalid); return; }
    let parsed;
    try { parsed = new URL(value); } catch (_) { fail(copy.invalid); return; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) { fail(copy.invalid); return; }
    stopped = true;
    if (timer) clearTimeout(timer);
    status.textContent = copy.redirecting;
    help.textContent = copy.help;
    location.replace(parsed.href);
  }

  async function poll() {
    if (stopped) return;
    if (!sessionId) {
      if (waitingForSession) { timer = setTimeout(poll, 250); return; }
      fail(copy.failed, copy.retry); return;
    }
    try {
      const response = await fetch(`/api/storage/remotes/config/${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (response.status === 401 || response.status === 403) { fail(copy.failed, copy.expired); return; }
      if (response.status === 404) { fail(copy.failed, copy.retry); return; }
      if (!response.ok) throw new Error(`http-${response.status}`);
      const data = await response.json();
      failures = 0;
      if (data && data.authUrl) { go(data.authUrl); return; }
      if (data && data.status === 'error') { fail(copy.failed, oauthErrorDetail(data.error)); return; }
      if (data && data.status === 'completed') { fail(copy.completed, copy.completedHelp); return; }
      timer = setTimeout(poll, 350);
    } catch (_) {
      failures += 1;
      if (failures >= 20) { fail(copy.failed, copy.retry); return; }
      timer = setTimeout(poll, Math.min(1200, 300 + failures * 80));
    }
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.opener) return;
    const payload = event.data || {};
    if (payload.type === 'dx-oauth-session') {
      const next = String(payload.session || '').trim();
      if (next) { sessionId = next; waitingForSession = false; failures = 0; if (timer) clearTimeout(timer); timer = setTimeout(poll, 0); }
      return;
    }
    if (payload.type === 'dx-oauth-url') go(payload.url);
  });

  poll();
})();
