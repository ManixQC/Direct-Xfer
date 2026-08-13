'use strict';
// Reception page: multiple files OR whole folders (tree preserved), with
// client-side quota/filter pre-checks, progress, speed and estimated time.
// Server-side enforcement remains authoritative.
(function () {
  var lang = (document.documentElement.lang || 'en').slice(0, 2);
  var T = {
    fr: {
      waiting: 'en attente', done: 'envoyé ✓', error: 'erreur ✗', blocked: 'lien révoqué ✗',
      resuming: 'reprise…', msgSent: 'Message envoyé ✓', s: 's', min: 'min',
      tooBig: 'trop volumineux', notAllowed: 'type non autorisé', quotaFull: 'quota atteint',
      infected: 'bloqué (virus détecté) ✗',
      blockedExec: 'bloqué (exécutable) ✗', storageCap: 'stockage serveur plein', senderReq: 'nom requis',
      maxFiles: 'nombre max atteint', maxPerUpload: 'max par envoi atteint', skipped: 'ignoré', remove: 'Retirer', filemsgPh: 'Message pour ce fichier (facultatif)',
      clearAll: 'Tout supprimer', clearConfirm: 'Retirer les {n} fichiers de la liste ?', queued: '{n} fichier(s)',
      encrypting: 'chiffrement…', encPassRequired: 'Saisissez la phrase secrète de chiffrement.',
      encKeyMissing: 'Lien incomplet : clé de chiffrement manquante.', encNoCrypto: 'Chiffrement non pris en charge par ce navigateur.',
      threadTitle: '💬 Discussion', threadHint: 'Échangez avec le destinataire de ce lien.', threadEmpty: 'Aucun message pour l’instant.',
      threadYou: 'Vous', threadOwner: 'Destinataire', threadName: 'Votre nom (facultatif)', threadPlaceholder: 'Écrire un message…',
      threadSend: 'Envoyer', threadSending: 'Envoi…', threadError: 'Envoi impossible, réessayez.', threadRate: 'Trop de messages, patientez un instant.',
      proxyWarn: '⚠ L’envoi a échoué après plusieurs tentatives. Si le serveur est derrière un reverse proxy (Nginx, Traefik, Apache…), vérifiez sa configuration : mise en tampon des requêtes désactivée et limites de taille/délai suffisantes pour les gros fichiers.',
    },
    en: {
      waiting: 'waiting', done: 'sent ✓', error: 'error ✗', blocked: 'revoked ✗',
      resuming: 'resuming…', msgSent: 'Message sent ✓', s: 's', min: 'min',
      tooBig: 'too large', notAllowed: 'type not allowed', quotaFull: 'quota reached',
      infected: 'blocked (virus found) ✗',
      blockedExec: 'blocked (executable) ✗', storageCap: 'server storage full', senderReq: 'name required',
      maxFiles: 'file limit reached', maxPerUpload: 'per-upload limit reached', skipped: 'skipped', remove: 'Remove', filemsgPh: 'Message for this file (optional)',
      clearAll: 'Remove all', clearConfirm: 'Remove all {n} files from the list?', queued: '{n} file(s)',
      encrypting: 'encrypting…', encPassRequired: 'Enter the encryption passphrase.',
      encKeyMissing: 'Incomplete link: missing encryption key.', encNoCrypto: 'Encryption not supported by this browser.',
      threadTitle: '💬 Conversation', threadHint: 'Chat with the owner of this link.', threadEmpty: 'No messages yet.',
      threadYou: 'You', threadOwner: 'Recipient', threadName: 'Your name (optional)', threadPlaceholder: 'Write a message…',
      threadSend: 'Send', threadSending: 'Sending…', threadError: 'Could not send, try again.', threadRate: 'Too many messages, please wait a moment.',
      proxyWarn: '⚠ The upload failed after several attempts. If the server is behind a reverse proxy (Nginx, Traefik, Apache…), check its configuration: disable request buffering and allow large enough body-size / timeout limits for big files.',
    },
    es: {
      waiting: 'en espera', done: 'enviado ✓', error: 'error ✗', blocked: 'revocado ✗',
      resuming: 'reanudando…', msgSent: 'Mensaje enviado ✓', s: 's', min: 'min',
      tooBig: 'demasiado grande', notAllowed: 'tipo no permitido', quotaFull: 'cuota alcanzada',
      infected: 'bloqueado (virus detectado) ✗',
      blockedExec: 'bloqueado (ejecutable) ✗', storageCap: 'almacenamiento lleno', senderReq: 'nombre requerido',
      maxFiles: 'límite de archivos', maxPerUpload: 'límite por envío', skipped: 'omitido', remove: 'Quitar', filemsgPh: 'Mensaje para este archivo (opcional)',
      clearAll: 'Quitar todo', clearConfirm: '¿Quitar los {n} archivos de la lista?', queued: '{n} archivo(s)',
      encrypting: 'cifrando…', encPassRequired: 'Introduce la frase de cifrado.',
      encKeyMissing: 'Enlace incompleto: falta la clave de cifrado.', encNoCrypto: 'Cifrado no compatible con este navegador.',
      threadTitle: '💬 Conversación', threadHint: 'Chatea con el destinatario de este enlace.', threadEmpty: 'Aún no hay mensajes.',
      threadYou: 'Tú', threadOwner: 'Destinatario', threadName: 'Tu nombre (opcional)', threadPlaceholder: 'Escribe un mensaje…',
      threadSend: 'Enviar', threadSending: 'Enviando…', threadError: 'No se pudo enviar, inténtalo de nuevo.', threadRate: 'Demasiados mensajes, espera un momento.',
      proxyWarn: '⚠ El envío falló tras varios intentos. Si el servidor está detrás de un proxy inverso (Nginx, Traefik, Apache…), revisa su configuración: desactiva el almacenamiento en búfer de las peticiones y permite límites de tamaño/tiempo suficientes para archivos grandes.',
    },
  };
  var t = function (k) { return (T[lang] || T.en)[k]; };
  var token = location.pathname.split('/')[2] || '';
  var cfg = window.DX_INBOX || {};
  var allow = (cfg.allowExt || []).map(function (e) { return String(e).toLowerCase(); });
  var block = (cfg.blockExt || []).map(function (e) { return String(e).toLowerCase(); });

  // Read by the language selector (pageShell): while true, a click on a
  // language link does not navigate immediately, so the ongoing upload isn't cut.
  window.__dxTransferActive = false;

  // Navigation guard while a transfer is running. We own this here (rather than
  // relying only on the page-shell's per-link handler) so it is reliable:
  //  • language links are intercepted in the CAPTURE phase and deferred until the
  //    upload finishes (reception.js then navigates to __dxPendingLangUrl);
  //  • any other navigation (refresh, back button, tab close) triggers the
  //    browser's "leave site?" confirmation so the transfer isn't cut by accident.
  document.addEventListener('click', function (e) {
    if (!window.__dxTransferActive) return;
    var a = e.target && e.target.closest && e.target.closest('.langsel a[data-lang]');
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // don't let the page-shell handler run too
    try {
      document.cookie = 'lang=' + a.getAttribute('data-lang') + '; Path=/; Max-Age=31536000; SameSite=Lax';
    } catch (_) {}
    window.__dxPendingLangUrl = a.getAttribute('href');
    var links = document.querySelectorAll('.langsel a[data-lang]');
    Array.prototype.forEach.call(links, function (b) { b.classList.remove('pending'); b.removeAttribute('title'); });
    a.classList.add('pending');
    var selEl = document.querySelector('.langsel');
    var pmsg = selEl ? selEl.getAttribute('data-lang-pending-msg') : '';
    if (pmsg) a.setAttribute('title', pmsg);
  }, true); // capture phase → runs before the anchor's own handler

  window.addEventListener('beforeunload', function (e) {
    if (!window.__dxTransferActive) return;
    e.preventDefault();
    e.returnValue = ''; // required for the confirmation prompt in most browsers
    return '';
  });

  var input = document.getElementById('up-input');
  var inputDir = document.getElementById('up-input-dir');
  var drop = document.getElementById('up-drop');
  var list = document.getElementById('up-list');
  var sendBtn = document.getElementById('up-send');
  var pickFilesBtn = document.getElementById('up-pick-files');
  var pickDirBtn = document.getElementById('up-pick-dir');
  var newFolderBtn = document.getElementById('up-new-folder');
  var folderCurrent = document.getElementById('up-folder-current');
  var listTools = document.getElementById('up-list-tools');
  var listCount = document.getElementById('up-list-count');
  var clearBtn = document.getElementById('up-clear');
  if (!input || !sendBtn || !list) return;

  var items = [];
  var uploadFolder = '';
  var folderStrings = cfg.folderStrings || {};

  function destinationPath(rel) {
    return uploadFolder ? uploadFolder + '/' + String(rel || '').replace(/^\/+/, '') : String(rel || '');
  }

  // "Remove all": clears the whole queue at once. Reuses removeItem for each file,
  // so in-progress uploads are aborted and resume ids forgotten, exactly like the
  // per-file ✕. Shown only while the list has at least one file.
  if (clearBtn) {
    clearBtn.textContent = t('clearAll');
    clearBtn.addEventListener('click', function () {
      if (!items.length) return;
      var msg = t('clearConfirm').replace('{n}', items.length);
      if (!window.confirm(msg)) return;
      items.slice().forEach(function (it) { removeItem(it); });
    });
  }
  function updateListTools() {
    if (!listTools) return;
    if (items.length) {
      listTools.hidden = false;
      if (listCount) listCount.textContent = t('queued').replace('{n}', items.length);
    } else {
      listTools.hidden = true;
    }
  }

  function fmtBytes(b) {
    if (b == null || isNaN(b)) return '';
    var u = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
    var n = b, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtEta(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return '~' + pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  // Same unit set the server uses for the quota line (formatBytes in
  // server.js), kept separate from fmtBytes above so a live refresh doesn't
  // suddenly switch the quota text to localized units mid-page.
  function fmtBytesPlain(b) {
    if (b == null || isNaN(b)) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var n = b, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  // Refreshes the "X files left / quota left" line right after a file is
  // accepted, using the authoritative counters the server just returned
  // (covers every visitor on this link, not just files sent from this tab).
  function updateLimits(resp) {
    if (resp.filesReceived != null) {
      cfg.filesReceived = resp.filesReceived;
      var elF = document.getElementById('up-limit-files');
      if (elF && cfg.maxFiles > 0 && cfg.limitFilesTpl) {
        var leftF = Math.max(0, cfg.maxFiles - cfg.filesReceived);
        elF.textContent = cfg.limitFilesTpl.replace('{v}', leftF).replace('{t}', cfg.maxFiles);
      }
    }
    if (resp.bytesReceived != null) {
      cfg.bytesReceived = resp.bytesReceived;
      var elQ = document.getElementById('up-limit-quota');
      if (elQ && cfg.maxTotalBytes > 0 && cfg.limitQuotaTpl) {
        var leftQ = Math.max(0, cfg.maxTotalBytes - cfg.bytesReceived);
        elQ.textContent = cfg.limitQuotaTpl.replace('{v}', fmtBytesPlain(leftQ)).replace('{t}', fmtBytesPlain(cfg.maxTotalBytes));
      }
    }
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function extOf(name) {
    var b = String(name || '').split('/').pop();
    var i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  }

  // Cumulative usage already accepted in this batch (waiting or sent) — lets us
  // pre-check the quota and file count as the visitor keeps adding files.
  function acceptedSoFar() {
    var bytes = 0, count = 0;
    items.forEach(function (it) {
      if (it.state === 'waiting' || it.state === 'sending' || it.state === 'done') {
        bytes += it.file.size || 0; count += 1;
      }
    });
    return { bytes: bytes, count: count };
  }

  // Returns a rejection reason key, or null if the file is acceptable.
  function rejectReason(file) {
    var ext = extOf(file.name);
    if (block.length && block.indexOf(ext) !== -1) return 'notAllowed';
    if (allow.length && allow.indexOf(ext) === -1) return 'notAllowed';
    if (cfg.maxFileBytes > 0 && file.size > cfg.maxFileBytes) return 'tooBig';
    var acc = acceptedSoFar();
    if (cfg.maxFiles > 0 && (cfg.filesReceived || 0) + acc.count >= cfg.maxFiles) return 'maxFiles';
    // Cap the number of files a visitor may queue in one deposit. This
    // counts only files added in this page session (not the link's cumulative total),
    // guiding the visitor before they send; maxFiles / maxFilesPerSender stay the
    // server-authoritative hard caps.
    if (cfg.maxFilesPerUpload > 0 && acc.count >= cfg.maxFilesPerUpload) return 'maxPerUpload';
    if (cfg.maxTotalBytes > 0 &&
        (cfg.bytesReceived || 0) + acc.bytes + (file.size || 0) > cfg.maxTotalBytes) return 'quotaFull';
    return null;
  }

  // Optional sender name, sent with each upload so the server files
  // the deposit under a per-sender subfolder (only when the link enables it).
  var senderEl = document.getElementById('up-sender');
  function senderParam() {
    // Send the visitor's name whenever the link groups by sender OR
    // requires a name (the server rejects a required-name upload without it).
    if (!cfg.groupBySender && !cfg.requireSenderName) return '';
    var v = senderEl ? String(senderEl.value || '').trim() : '';
    return v ? '&sender=' + encodeURIComponent(v) : '';
  }
  // Block sending until a required name is provided.
  function senderNameMissing() {
    if (!cfg.requireSenderName) return false;
    return !(senderEl && String(senderEl.value || '').trim());
  }

  function folderErrorText(code) {
    if (code === 'invalid-folder') return folderStrings.invalid || folderStrings.fail || 'Invalid folder name.';
    if (code === 'folder-exists') return folderStrings.exists || folderStrings.fail || 'Folder already exists.';
    return folderStrings.fail || 'Could not create the folder.';
  }

  if (newFolderBtn) newFolderBtn.addEventListener('click', function () {
    if (window.__dxTransferActive) {
      window.alert(folderStrings.busy || folderStrings.fail || 'Wait for the upload to finish.');
      return;
    }
    var name = window.prompt(folderStrings.prompt || 'New folder name:');
    if (name == null) return;
    name = String(name).trim();
    if (!name) return;
    newFolderBtn.disabled = true;
    var sender = senderParam();
    var suffix = sender ? '?' + sender.slice(1) : '';
    fetch('/u/' + encodeURIComponent(token) + '/folder' + suffix, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: '', name: name }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error('folder'); e.code = data.error || ''; throw e; }
        return data;
      });
    }).then(function (data) {
      uploadFolder = data.path || data.name || name;
      if (folderCurrent) {
        folderCurrent.hidden = false;
        folderCurrent.textContent = (folderStrings.destination || 'Destination: {path}').replace('{path}', uploadFolder);
      }
      // The sender/date prefix is part of the server destination. Keep it stable
      // after the folder is created so files cannot land in a different tree.
      if (senderEl) senderEl.disabled = true;
    }).catch(function (e) {
      window.alert(folderErrorText(e && e.code));
    }).then(function () {
      newFolderBtn.disabled = false;
    });
  });

  var msgEl = document.getElementById('up-message');
  var msgLabelEl = document.querySelector('.up-msg-label');
  var msgLabelText = msgLabelEl ? msgLabelEl.textContent : '';

  function refreshBtn() {
    var hasMsg = !!(msgEl && msgEl.value.trim());
    sendBtn.disabled = !(items.some(function (it) { return it.state === 'waiting'; }) || hasMsg);
    updateListTools();
  }

  // Posts the visitor's optional message (once) before the files are uploaded.
  function sendMessageIfAny() {
    var text = msgEl ? msgEl.value.trim() : '';
    if (!text) return Promise.resolve();
    return fetch('/u/' + encodeURIComponent(token) + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: text }),
    }).then(function (r) {
      if (r.ok) {
        msgEl.value = '';
        if (msgLabelEl) msgLabelEl.textContent = t('msgSent');
      }
    }).catch(function () {});
  }

  // Posts a per-file message once its file has been received, tagged with the name.
  function sendFileMessage(it) {
    var input = it.msgInput;
    var text = input ? String(input.value || '').trim() : '';
    if (!text) return;
    fetch('/u/' + encodeURIComponent(token) + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: text, file: it.messagePath || destinationPath(it.relPath) }),
    }).then(function (r) {
      if (r.ok && input) { input.value = ''; input.disabled = true; input.placeholder = t('msgSent'); }
    }).catch(function () {});
  }

  if (msgEl) {
    msgEl.addEventListener('input', function () {
      if (msgLabelEl && msgLabelEl.textContent !== msgLabelText) msgLabelEl.textContent = msgLabelText;
      refreshBtn();
    });
  }

  // entries: [{ file, relPath }]
  function addEntries(entries) {
    entries.forEach(function (entry) {
      var f = entry.file;
      var relPath = entry.relPath || f.name;
      var reason = rejectReason(f);

      var row = el('div', 'uprow' + (reason ? ' skip' : ''));
      var main = el('div', 'upmain');
      var top = el('div', 'uptop');
      var status = el('span', 'upstatus', reason ? t(reason) : t('waiting'));
      if (reason) status.className = 'upstatus err';
      top.appendChild(el('span', 'upname', relPath));
      top.appendChild(status);
      var bar = el('div', 'upbar');
      var fill = el('i');
      bar.appendChild(fill);
      var meta = el('div', 'upmeta');
      var speed = el('span', 'upspeed');
      var eta = el('span', 'upeta');
      meta.appendChild(el('span', 'upsize', fmtBytes(f.size)));
      meta.appendChild(speed);
      meta.appendChild(eta);
      main.appendChild(top);
      if (!reason) main.appendChild(bar);
      main.appendChild(meta);
      row.appendChild(el('span', 'upicon', relPath.indexOf('/') !== -1 ? '🗂️' : '📄'));
      row.appendChild(main);

      var item = {
        file: f, relPath: relPath, row: row, fill: fill, status: status,
        speed: speed, eta: eta, xhr: null, state: reason ? 'skipped' : 'waiting',
      };

      // Optional per-file message (sent once the file is received).
      if (!reason) {
        var fmsg = el('input', 'upmsg');
        fmsg.type = 'text';
        fmsg.maxLength = 2000;
        fmsg.placeholder = t('filemsgPh');
        main.appendChild(fmsg);
        item.msgInput = fmsg;
      }

      // Remove/cancel button — active in any state. For an in-progress upload it
      // aborts the request, which makes the server delete the incomplete file.
      var rm = el('button', 'upcancel', '✕');
      rm.type = 'button';
      rm.title = t('remove');
      rm.setAttribute('aria-label', t('remove'));
      rm.addEventListener('click', function () { removeItem(item); });
      row.appendChild(rm);

      list.appendChild(row);
      items.push(item);
    });
    refreshBtn();
  }

  // Removes a file from the list at any time. An in-progress upload is aborted
  // (the server then discards the partial file); waiting files are simply
  // dropped so the send loop skips them.
  function removeItem(it) {
    if (it.state === 'sending' && it.xhr) {
      try { it.xhr.abort(); } catch (_) {}
    }
    it.state = 'cancelled';
    clearUploadId(it); // forget the resume id so it won't auto-resume later
    var idx = items.indexOf(it);
    if (idx !== -1) items.splice(idx, 1);
    if (it.row && it.row.parentNode) it.row.parentNode.removeChild(it.row);
    refreshBtn();
  }

  function filesToEntries(fileList) {
    var out = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      out.push({ file: f, relPath: f.webkitRelativePath || f.name });
    }
    return out;
  }

  input.addEventListener('change', function () { addEntries(filesToEntries(input.files)); input.value = ''; });
  if (inputDir) {
    inputDir.addEventListener('change', function () { addEntries(filesToEntries(inputDir.files)); inputDir.value = ''; });
  }
  if (pickFilesBtn) pickFilesBtn.addEventListener('click', function () { input.click(); });
  if (pickDirBtn && inputDir) pickDirBtn.addEventListener('click', function () { inputDir.click(); });

  // --- Drag & drop, including whole folders (webkitGetAsEntry traversal) ---
  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (!entry) return resolve();
      if (entry.isFile) {
        entry.file(function (f) { out.push({ file: f, relPath: prefix + f.name }); resolve(); }, function () { resolve(); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        (function read() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              var next = all.map(function (e) { return walkEntry(e, prefix + entry.name + '/', out); });
              Promise.all(next).then(function () { resolve(); });
            } else {
              all = all.concat(Array.prototype.slice.call(batch));
              read(); // readEntries returns at most 100 entries per call
            }
          }, function () { resolve(); });
        })();
      } else { resolve(); }
    });
  }

  if (drop) {
    ['dragover', 'dragenter'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var hasEntries = dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function';
      if (hasEntries) {
        var roots = [];
        for (var i = 0; i < dt.items.length; i++) {
          var en = dt.items[i].webkitGetAsEntry && dt.items[i].webkitGetAsEntry();
          if (en) roots.push(en);
        }
        var out = [];
        Promise.all(roots.map(function (r) { return walkEntry(r, '', out); })).then(function () {
          if (out.length) addEntries(out);
          else if (dt.files && dt.files.length) addEntries(filesToEntries(dt.files));
        });
      } else if (dt.files && dt.files.length) {
        addEntries(filesToEntries(dt.files));
      }
    });
  }

  function clearMeta(it) { it.speed.textContent = ''; it.eta.textContent = ''; }

  function serverReasonText(code) {
    if (code === 'ext-blocked' || code === 'ext-not-allowed') return t('notAllowed');
    if (code === 'file-too-large' || code === 'too-large') return t('tooBig');
    if (code === 'quota-full') return t('quotaFull');
    if (code === 'storage-cap') return t('storageCap');
    if (code === 'max-files') return t('maxFiles');
    if (code === 'infected') return t('infected');
    if (code === 'content-blocked') return t('blockedExec');
    if (code === 'sender-required') return t('senderReq');
    if (code === 'revoked' || code === 'locked' || code === 'stopped') return t('blocked');
    return t('error');
  }

  // --- Resumable uploads -------------------------------------------------
  // A stable upload id (kept in localStorage, keyed by token + path + size +
  // mtime) lets an interrupted transfer resume from the server-side offset,
  // even after a page reload. Ids match the server's /^[A-Za-z0-9_-]{6,64}$/.
  var LS_PREFIX = 'dxup:';
  var RESUME_ATTEMPTS = 6; // network retries before giving up on a file
  var CHUNK_SIZE = 8 * 1024 * 1024; // per-request upload chunk (bounded for proxies)

  function lsKeyFor(it) {
    return LS_PREFIX + token + '|' + destinationPath(it.relPath) + '|' + it.file.size + '|' + (it.file.lastModified || 0);
  }
  function genUploadId() {
    var alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var arr = null;
    if (window.crypto && crypto.getRandomValues) { arr = new Uint8Array(24); crypto.getRandomValues(arr); }
    var out = '';
    for (var i = 0; i < 24; i++) out += alpha[(arr ? arr[i] : Math.floor(Math.random() * 256)) & 63];
    return out;
  }
  function uploadIdFor(it) {
    var key = lsKeyFor(it);
    it.lsKey = key;
    var id = null;
    try { id = localStorage.getItem(key); } catch (_) {}
    if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      id = genUploadId();
      try { localStorage.setItem(key, id); } catch (_) {}
      it.resumeCandidate = false; // brand-new id → the server holds nothing for it yet
    } else {
      it.resumeCandidate = true; // a prior attempt (this session or before a reload) may have a .part
    }
    return id;
  }
  function clearUploadId(it) {
    try { if (it.lsKey) localStorage.removeItem(it.lsKey); } catch (_) {}
  }

  // Asks the server how many bytes it already holds for this upload id.
  function fetchOffset(id) {
    return fetch('/u/' + encodeURIComponent(token) + '/upload-status?id=' + encodeURIComponent(id), {
      credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) return 0;
      return r.json().then(function (d) { return Math.max(0, (d && d.offset) || 0); });
    }).catch(function () { return 0; });
  }

  // Fatal (non-resumable) server rejections: stop retrying and show the reason.
  function isFatalCode(code) {
    return code === 'ext-blocked' || code === 'ext-not-allowed' || code === 'file-too-large' ||
      code === 'too-large' || code === 'quota-full' || code === 'storage-cap' || code === 'max-files' ||
      code === 'infected' || code === 'content-blocked' || code === 'sender-required' ||
      code === 'revoked' || code === 'locked' || code === 'stopped';
  }

  // --- End-to-end encryption (optional, when the reception link is encrypted) ---
  var ENC = (cfg.enc && cfg.enc.on) ? cfg.enc : null; // { on:true, mode:'key'|'pass' }
  var encCtxPromise = null;

  function linkKey() { var m = /[#&]k=([A-Za-z0-9\-_]+)/.exec(location.hash || ''); return m ? m[1] : ''; }

  // Resolves the encryption context once (key/passphrase). Rejects with a coded
  // Error ('nopass' | 'nokey' | 'nocrypto') the caller turns into a message.
  function ensureEncKey() {
    if (encCtxPromise) return encCtxPromise;
    if (!window.DXCrypto || !window.DXCrypto.available) return Promise.reject(new Error('nocrypto'));
    var C = window.DXCrypto;
    if (ENC.mode === 'pass') {
      var el = document.getElementById('up-passphrase');
      var pass = el ? el.value : '';
      if (!pass) return Promise.reject(new Error('nopass'));
      var salt = C.randomSalt();
      encCtxPromise = C.deriveKey(pass, salt).then(function (key) { return { mode: 'pass', key: key, salt: salt }; });
    } else {
      var k = linkKey();
      if (!k) return Promise.reject(new Error('nokey'));
      encCtxPromise = C.importRawKey(C.b64urlDecode(k)).then(function (key) { return { mode: 'key', key: key, salt: null }; });
    }
    return encCtxPromise;
  }

  // Sets it.upBlob / it.upName / it.upSize / it.upId — the actual bytes to upload.
  // Plaintext: the file itself with a stable (resume-after-reload) id. Encrypted:
  // a DXE container with an opaque name and a fresh per-session id (re-encryption
  // after a reload would differ, so those uploads don't resume across reloads).
  function prepareUpload(it) {
    if (!ENC) {
      it.upBlob = it.file; it.upName = destinationPath(it.relPath); it.messagePath = it.upName; it.upSize = it.file.size;
      it.upId = uploadIdFor(it);
      return Promise.resolve();
    }
    it.status.textContent = t('encrypting');
    it.status.className = 'upstatus';
    return ensureEncKey().then(function (ctx) {
      return window.DXCrypto.encryptFile(it.file, ctx.mode, {
        key: ctx.key, salt: ctx.salt,
        onProgress: function (f) { it.status.textContent = t('encrypting') + ' ' + Math.round(f * 100) + '%'; },
      });
    }).then(function (blob) {
      it.upBlob = blob;
      it.upName = destinationPath(genUploadId() + '.dxe'); // real name is encrypted inside the container
      it.messagePath = destinationPath(it.relPath);
      it.upSize = blob.size;
      it.upId = genUploadId(); // not persisted
      it.lsKey = null;
      it.resumeCandidate = false; // fresh per-session id → nothing to resume, skip the pre-flight
    });
  }

  function uploadOne(it) {
    if (it.state !== 'waiting') return Promise.resolve(); // removed before its turn
    it.state = 'sending';
    it.status.textContent = '0%';
    it.status.className = 'upstatus';
    return prepareUpload(it).then(function () { return runUpload(it); }, function (err) {
      it.state = 'error';
      it.status.className = 'upstatus err';
      it.status.textContent =
        (err && err.message === 'nopass') ? t('encPassRequired')
        : (err && err.message === 'nokey') ? t('encKeyMissing')
        : (err && err.message === 'nocrypto') ? t('encNoCrypto')
        : t('error');
    });
  }

  function runUpload(it) {
    var id = it.upId;
    var size = it.upSize;

    // One POST attempt sending a single fixed-size chunk starting at `offset`.
    // Chunking (rather than one giant request) keeps each request bounded — which
    // survives reverse-proxy body-size limits and means a network drop only costs
    // the current chunk, not the whole tail. The server appends each chunk to the
    // .part file and replies 409 `incomplete` until the last one completes it.
    // Resolves with { done, resp } | { progress, offset } | { retry, offset }
    //             | { fatal, code } | { cancelled }.
    function attempt(offset) {
      return new Promise(function (resolve) {
        if (it.state === 'cancelled') return resolve({ cancelled: true });
        var end = Math.min(size, offset + CHUNK_SIZE);
        it.startTime = Date.now();
        var xhr = new XMLHttpRequest();
        it.xhr = xhr;
        var qs = '?path=' + encodeURIComponent(it.upName) +
          '&id=' + encodeURIComponent(id) + '&size=' + size + '&offset=' + offset + senderParam();
        xhr.open('POST', '/u/' + encodeURIComponent(token) + '/upload' + qs);
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var sent = offset + e.loaded;
          var p = size > 0 ? Math.round((sent / size) * 100) : 100;
          it.fill.style.width = p + '%';
          it.status.textContent = p + '%';
          var elapsed = (Date.now() - it.startTime) / 1000;
          if (elapsed > 0.4) {
            var speed = e.loaded / elapsed; // bytes/s for this chunk
            it.speed.textContent = '↑ ' + fmtBytes(speed) + '/s';
            if (speed > 0 && sent < size) it.eta.textContent = fmtEta((size - sent) / speed);
          }
        };
        xhr.onabort = function () { it.state = 'cancelled'; resolve({ cancelled: true }); };
        xhr.onload = function () {
          if (it.state === 'cancelled') return resolve({ cancelled: true });
          if (xhr.status >= 200 && xhr.status < 300) {
            var resp = null; try { resp = JSON.parse(xhr.responseText); } catch (_) {}
            return resolve({ done: true, resp: resp }); // 2xx only on the final chunk
          }
          var code = '', off = null;
          try { var j = JSON.parse(xhr.responseText) || {}; code = j.error || ''; if (j.offset != null) off = j.offset; } catch (_) {}
          if (xhr.status === 409) {
            // Chunk stored, more to go (or a resync): the server sent the offset.
            if (off != null && off > offset) return resolve({ progress: true, offset: off });
            return resolve({ retry: true, offset: off }); // no progress → recoverable retry
          }
          if (isFatalCode(code)) return resolve({ fatal: true, code: code });
          return resolve({ retry: true, offset: null }); // other error: try to resume
        };
        xhr.onerror = function () {
          if (it.state === 'cancelled') return resolve({ cancelled: true });
          resolve({ retry: true, offset: null }); // network drop: resume
        };
        // Body carries just this chunk: [offset, end).
        xhr.send(it.upBlob.slice(offset, end));
      });
    }

    function finishOk(resp) {
      clearMeta(it);
      clearUploadId(it);
      it.state = 'done';
      it.fill.style.width = '100%';
      it.status.textContent = t('done');
      it.status.className = 'upstatus ok';
      if (resp) updateLimits(resp);
      sendFileMessage(it);
    }

    // Chunk loop: each accepted chunk advances the offset with a full retry budget;
    // a recoverable failure re-syncs the offset and retries after a short backoff.
    function loop(offset, attemptsLeft) {
      return attempt(offset).then(function (r) {
        if (r.cancelled) return;
        if (r.done) return finishOk(r.resp);
        if (r.progress) {
          if (it.state === 'cancelled') return;
          var o = Math.min(r.offset, size);
          return loop(o, RESUME_ATTEMPTS); // progress made → reset the retry budget
        }
        if (r.fatal) {
          clearMeta(it);
          clearUploadId(it); // server discarded the partial on rejection
          it.state = 'error';
          it.status.textContent = serverReasonText(r.code);
          it.status.className = 'upstatus err';
          return;
        }
        if (attemptsLeft <= 0) {
          clearMeta(it);
          it.state = 'error';
          it.status.textContent = t('error'); // .part is kept: a later run can still resume
          it.status.className = 'upstatus err';
          showProxyWarning(); // repeated network failures often mean a proxy misconfig
          return;
        }
        it.speed.textContent = ''; it.eta.textContent = '';
        it.status.textContent = t('resuming');
        var nextOffset = (r.offset != null) ? Promise.resolve(Math.max(0, r.offset)) : fetchOffset(id);
        return nextOffset.then(function (o) {
          if (it.state === 'cancelled') return;
          if (o > size) o = size;
          return new Promise(function (res) { setTimeout(res, 600); })
            .then(function () { return loop(o, attemptsLeft - 1); });
        });
      });
    }

    // Start from whatever the server already holds (covers resume-after-reload). A
    // brand-new id has nothing on the server, so skip the round-trip and start at 0;
    // if we're ever wrong the server replies 409 offset-mismatch and the loop resyncs.
    var startAt = it.resumeCandidate ? fetchOffset(id) : Promise.resolve(0);
    return startAt.then(function (o) {
      if (it.state === 'cancelled') return;
      if (o > size) o = size;
      return loop(o, RESUME_ATTEMPTS);
    });
  }

  // Shown once when a transfer gives up after all retries. Behind a reverse proxy
  // this is usually request buffering, or too-small body-size / timeout limits.
  function showProxyWarning() {
    if (document.getElementById('up-proxy-warn')) return;
    var w = document.createElement('div');
    w.id = 'up-proxy-warn';
    w.className = 'up-warn';
    w.textContent = t('proxyWarn');
    if (list && list.parentNode) list.parentNode.insertBefore(w, list);
    else if (sendBtn && sendBtn.parentNode) sendBtn.parentNode.insertBefore(w, sendBtn);
  }

  function encError(err) {
    window.__dxTransferActive = false;
    sendBtn.disabled = false;
    if (newFolderBtn) newFolderBtn.disabled = false;
    var msg = (err && err.message === 'nokey') ? t('encKeyMissing')
      : (err && err.message === 'nocrypto') ? t('encNoCrypto')
      : t('encPassRequired');
    var el = document.getElementById('enc-err');
    if (!el) { el = document.createElement('p'); el.id = 'enc-err'; el.className = 'err'; sendBtn.parentNode.insertBefore(el, sendBtn); }
    el.textContent = msg;
    var p = document.getElementById('up-passphrase');
    if (p && (!err || err.message === 'nopass')) p.focus();
  }

  // Upload several files at once. Sending strictly one-at-a-time serializes a
  // round-trip (or more) per file, which is slow for many files — especially with
  // network latency. A small pool overlaps them; the server keys each upload by its
  // own id (one .part + one per-id lock each), so concurrent DISTINCT files are safe.
  var UPLOAD_CONCURRENCY = 4;

  function startSend() {
    var el = document.getElementById('enc-err'); if (el) el.textContent = '';
    sendBtn.disabled = true;
    if (newFolderBtn) newFolderBtn.disabled = true;
    window.__dxTransferActive = true;
    var pending = items.filter(function (it) { return it.state === 'waiting'; });
    var n = Math.max(1, Math.min(UPLOAD_CONCURRENCY, pending.length));
    // Attach the visitor's note first, then upload the files through a worker pool.
    sendMessageIfAny().then(function () {
      var idx = 0;
      function next() {
        if (idx >= pending.length) return Promise.resolve();
        var it = pending[idx++];
        return uploadOne(it).then(next); // each worker pulls the next queued file
      }
      var workers = [];
      for (var w = 0; w < n; w++) workers.push(next());
      return Promise.all(workers);
    }).then(function () {
      window.__dxTransferActive = false;
      if (newFolderBtn) newFolderBtn.disabled = false;
      refreshBtn();
      // A language change was requested during the upload: apply it now.
      if (window.__dxPendingLangUrl) {
        var url = window.__dxPendingLangUrl;
        window.__dxPendingLangUrl = null;
        location.href = url;
      }
    });
  }

  sendBtn.addEventListener('click', function () {
    // A required visitor name must be filled before anything is sent.
    if (senderNameMissing()) {
      window.alert(cfg.senderRequiredMsg || 'Please enter your name before sending.');
      if (senderEl) { try { senderEl.focus(); } catch (_) {} }
      return;
    }
    // For encrypted links, validate the key/passphrase up front so we don't fail
    // file-by-file. sendMessageIfAny() is not encrypted (it's a plain note).
    if (ENC && items.some(function (it) { return it.state === 'waiting'; })) {
      sendBtn.disabled = true;
      ensureEncKey().then(startSend, function (err) { encCtxPromise = null; encError(err); });
    } else {
      startSend();
    }
  });

  // Two-way reception thread. The visitor reads the running
  // conversation with the link owner and posts replies. Rendered only when the
  // link enables it. Every message is inserted via textContent (never innerHTML),
  // so a message can never inject markup.
  (function initThread() {
    if (!cfg.threadEnabled) return;
    var box = document.getElementById('up-thread');
    if (!box) return;
    var tk = cfg.token || token;
    var head = document.createElement('div'); head.className = 'up-thread-head';
    var h = document.createElement('h2'); h.textContent = t('threadTitle'); head.appendChild(h);
    var hint = document.createElement('p'); hint.className = 'muted sm'; hint.textContent = t('threadHint'); head.appendChild(hint);
    box.appendChild(head);
    var listEl = document.createElement('div'); listEl.className = 'up-thread-list'; box.appendChild(listEl);
    var form = document.createElement('div'); form.className = 'up-thread-form';
    var nameEl = document.createElement('input');
    nameEl.type = 'text'; nameEl.className = 'up-msg'; nameEl.maxLength = 80; nameEl.placeholder = t('threadName');
    if (senderEl && senderEl.value) nameEl.value = senderEl.value; // reuse the sender name if asked
    var textEl = document.createElement('textarea');
    textEl.className = 'up-msg'; textEl.rows = 2; textEl.maxLength = 2000; textEl.placeholder = t('threadPlaceholder');
    var sendEl = document.createElement('button');
    sendEl.type = 'button'; sendEl.className = 'btn sm up-thread-send'; sendEl.textContent = t('threadSend');
    form.appendChild(nameEl); form.appendChild(textEl); form.appendChild(sendEl);
    box.appendChild(form);
    box.hidden = false;

    var lastRenderKey = '';
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmt(at) { try { var d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()); } catch (_) { return ''; } }
    function render(messages) {
      var key = messages.map(function (m) { return m.id; }).join(',');
      if (key === lastRenderKey) return;
      lastRenderKey = key;
      listEl.textContent = '';
      if (!messages.length) {
        var em = document.createElement('p'); em.className = 'muted sm up-thread-empty'; em.textContent = t('threadEmpty'); listEl.appendChild(em); return;
      }
      messages.forEach(function (m) {
        var row = document.createElement('div'); row.className = 'up-thread-msg ' + (m.from === 'owner' ? 'from-owner' : 'from-visitor');
        var meta = document.createElement('div'); meta.className = 'up-thread-meta';
        meta.textContent = (m.from === 'owner' ? t('threadOwner') : (m.name || t('threadYou'))) + ' · ' + fmt(m.at);
        var bodyEl = document.createElement('div'); bodyEl.className = 'up-thread-text'; bodyEl.textContent = m.text;
        row.appendChild(meta); row.appendChild(bodyEl); listEl.appendChild(row);
      });
      listEl.scrollTop = listEl.scrollHeight;
    }
    function load() {
      fetch('/u/' + encodeURIComponent(tk) + '/thread', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && Array.isArray(d.messages)) render(d.messages); })
        .catch(function () {});
    }
    var sending = false;
    function done(label) { sending = false; sendEl.disabled = false; sendEl.textContent = label; }
    function post() {
      if (sending) return;
      var text = String(textEl.value || '').trim();
      if (!text) return;
      sending = true; sendEl.disabled = true;
      var label = t('threadSend'); sendEl.textContent = t('threadSending');
      fetch('/u/' + encodeURIComponent(tk) + '/thread', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(nameEl.value || '').trim(), text: text })
      }).then(function (r) {
        if (r.status === 429) { window.alert(t('threadRate')); done(label); return; }
        if (!r.ok) throw new Error('post');
        return r.json().then(function (d) {
          if (d && Array.isArray(d.messages)) { textEl.value = ''; lastRenderKey = ''; render(d.messages); }
          done(label);
        });
      }).catch(function () { window.alert(t('threadError')); done(label); });
    }
    sendEl.addEventListener('click', post);
    textEl.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); post(); } });
    load();
    // Poll while the tab is visible so an owner reply appears without a manual refresh.
    setInterval(function () { if (document.visibilityState !== 'hidden') load(); }, 12000);
  })();
})();
