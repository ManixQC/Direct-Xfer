'use strict';
(() => {
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
  const ok = document.body && document.body.dataset.dxGoogleOauthOk === '1';
  try {
    if (window.opener) window.opener.postMessage({ type:'dx-google-oauth-result', ok }, location.origin);
  } catch (_) {}
  setTimeout(() => { try { window.close(); } catch (_) {} }, 900);
})();
