'use strict';
// Direct-Xfer — collaboration link client (two-way shared folder).
// Lists the folder's current contents (live-refreshed), lets the visitor download,
// upload (chunked + resumable, same protocol as reception links) and — when the
// link allows it — delete items. Self-contained, no third party.
(function () {
  var cfg = window.DX_COLLAB || {};
  var token = cfg.token || '';
  var S = cfg.strings || {};
  var CHUNK_SIZE = 8 * 1024 * 1024;
  var POLL_MS = 5000;

  var listEl = document.getElementById('cl-list');
  var crumbsEl = document.getElementById('cl-crumbs');
  var refreshBtn = document.getElementById('cl-refresh');
  var newFolderBtn = document.getElementById('cl-new-folder');
  var upList = document.getElementById('up-list');
  var drop = document.getElementById('up-drop');
  var input = document.getElementById('up-input');
  var inputDir = document.getElementById('up-input-dir');
  var pickFiles = document.getElementById('up-pick-files');
  var pickDir = document.getElementById('up-pick-dir');
  if (!listEl || !token) return;

  var curSub = '';       // current subfolder (relative to the collab root)
  var uploading = false; // pause live polling while an upload runs
  var queue = [];        // pending upload items
  var pollTimer = null;

  // --- helpers ---
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  }
  function fmtEta(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    sec = Math.round(sec);
    if (sec < 60) return sec + 's';
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm ' + s + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function enc(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }

  // --- folder listing (live) ---
  function renderCrumbs() {
    crumbsEl.textContent = '';
    var parts = curSub ? curSub.split('/') : [];
    var home = el('a', 'crumb', S.home || 'Home');
    home.href = '#'; home.addEventListener('click', function (e) { e.preventDefault(); go(''); });
    crumbsEl.appendChild(home);
    var acc = '';
    parts.forEach(function (p, i) {
      acc = acc ? acc + '/' + p : p;
      crumbsEl.appendChild(document.createTextNode(' / '));
      if (i === parts.length - 1) {
        crumbsEl.appendChild(el('span', 'crumb active', p));
      } else {
        var target = acc;
        var a = el('a', 'crumb', p);
        a.href = '#'; a.addEventListener('click', function (e) { e.preventDefault(); go(target); });
        crumbsEl.appendChild(a);
      }
    });
  }

  function render(data) {
    renderCrumbs();
    listEl.textContent = '';
    var entries = (data && data.entries) || [];
    if (curSub) {
      var up = el('div', 'cl-row cl-up');
      up.appendChild(el('span', 'cl-ico', '⬆'));
      var upName = el('a', 'cl-name', S.parent || '..');
      upName.href = '#';
      var parent = curSub.indexOf('/') !== -1 ? curSub.replace(/\/[^/]*$/, '') : '';
      upName.addEventListener('click', function (e) { e.preventDefault(); go(parent); });
      up.appendChild(upName);
      listEl.appendChild(up);
    }
    if (!entries.length) {
      listEl.appendChild(el('div', 'cl-empty muted', S.empty || 'Empty folder'));
      return;
    }
    entries.forEach(function (it) {
      var row = el('div', 'cl-row');
      row.appendChild(el('span', 'cl-ico', it.isDir ? '📁' : '📄'));
      if (it.isDir) {
        var a = el('a', 'cl-name', it.name);
        a.href = '#';
        a.addEventListener('click', function (e) { e.preventDefault(); go(it.rel); });
        row.appendChild(a);
        row.appendChild(el('span', 'cl-size', ''));
      } else {
        row.appendChild(el('span', 'cl-name', it.name));
        row.appendChild(el('span', 'cl-size muted', fmtBytes(it.size)));
        var dl = el('a', 'btn ghost xs', S.download || 'Download');
        dl.href = '/c/' + encodeURIComponent(token) + '/file/' + enc(it.rel);
        dl.setAttribute('download', '');
        dl.setAttribute('rel', 'noopener');
        row.appendChild(dl);
      }
      if (cfg.allowDelete) {
        var del = el('button', 'btn danger xs', S.del || 'Delete');
        del.addEventListener('click', function () { doDelete(it); });
        row.appendChild(del);
      }
      listEl.appendChild(row);
    });
  }

  function loadList() {
    return fetch('/c/' + encodeURIComponent(token) + '/list?sub=' + encodeURIComponent(curSub), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.reload(); return null; } // password expired
        if (!r.ok) throw new Error('list');
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () { /* transient; the next poll retries */ });
  }
  function go(sub) { curSub = sub || ''; loadList(); }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { if (!uploading) loadList(); }, POLL_MS);
  }

  // --- delete ---
  function doDelete(it) {
    var msg = (S.delConfirm || 'Delete "{n}"?').split('{n}').join(it.name);
    if (!window.confirm(msg)) return;
    fetch('/c/' + encodeURIComponent(token) + '/delete', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: it.rel }),
    }).then(function (r) {
      if (!r.ok) throw new Error('del');
      loadList();
    }).catch(function () { window.alert(S.delFail || 'Delete failed'); });
  }

  function folderErrorText(code) {
    if (code === 'invalid-folder') return S.folderInvalid || S.folderFail || 'Invalid folder name.';
    if (code === 'folder-exists') return S.folderExists || S.folderFail || 'Folder already exists.';
    return S.folderFail || 'Could not create the folder.';
  }

  function createFolder() {
    if (uploading) {
      window.alert(S.folderBusy || S.folderFail || 'Wait for the upload to finish.');
      return;
    }
    var name = window.prompt(S.folderPrompt || 'New folder name:');
    if (name == null) return;
    name = String(name).trim();
    if (!name) return;
    if (newFolderBtn) newFolderBtn.disabled = true;
    fetch('/c/' + encodeURIComponent(token) + '/folder', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: curSub, name: name }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error('folder'); e.code = data.error || ''; throw e; }
        return data;
      });
    }).then(function (data) {
      go(data.path || (curSub ? curSub + '/' + name : name));
    }).catch(function (e) {
      window.alert(folderErrorText(e && e.code));
    }).then(function () {
      if (newFolderBtn) newFolderBtn.disabled = false;
    });
  }

  // --- uploads (chunked + resumable) ---
  function genId() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }
  function addRow(name, size) {
    var row = el('div', 'uprow');
    var main = el('div', 'upmain');
    var top = el('div', 'uptop');
    var status = el('span', 'upstatus', '0%');
    top.appendChild(el('span', 'upname', name));
    top.appendChild(status);
    var bar = el('div', 'upbar');
    var fill = document.createElement('i');
    bar.appendChild(fill);
    var meta = el('div', 'upmeta');
    var speed = el('span', 'upspeed');
    meta.appendChild(el('span', 'upsize', fmtBytes(size)));
    meta.appendChild(speed);
    main.appendChild(top); main.appendChild(bar); main.appendChild(meta);
    row.appendChild(el('span', 'upicon', name.indexOf('/') !== -1 ? '🗂️' : '📄'));
    row.appendChild(main);
    upList.appendChild(row);
    return { row: row, fill: fill, status: status, speed: speed };
  }

  // Uploads one file as a sequence of chunks; resumes from the server's offset on
  // a 409, retries a few times on a network drop. Resolves true on success.
  function uploadOne(item) {
    var file = item.file, relPath = item.relPath, size = file.size;
    var id = genId();
    var ui = addRow(relPath, size);
    var retries = 0;

    function attempt(offset) {
      return new Promise(function (resolve) {
        var end = Math.min(size, offset + CHUNK_SIZE);
        var start = Date.now();
        var xhr = new XMLHttpRequest();
        var qs = '?path=' + encodeURIComponent(relPath) + '&id=' + encodeURIComponent(id) +
          '&size=' + size + '&offset=' + offset;
        xhr.open('POST', '/c/' + encodeURIComponent(token) + '/upload' + qs);
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var sent = offset + e.loaded;
          var p = size > 0 ? Math.round((sent / size) * 100) : 100;
          ui.fill.style.width = p + '%';
          ui.status.textContent = p + '%';
          var elapsed = (Date.now() - start) / 1000;
          if (elapsed > 0.4) {
            var sp = e.loaded / elapsed;
            ui.speed.textContent = '↑ ' + fmtBytes(sp) + '/s' + (sp > 0 && sent < size ? ' · ' + fmtEta((size - sent) / sp) : '');
          }
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) return resolve({ done: true });
          var off = null, code = '';
          try { var j = JSON.parse(xhr.responseText) || {}; code = j.error || ''; if (j.offset != null) off = j.offset; } catch (_) {}
          if (xhr.status === 409) {
            if (off != null && off > offset) return resolve({ next: off });
            return resolve({ retry: true, offset: off });
          }
          return resolve({ fatal: true, code: code });
        };
        xhr.onerror = function () { resolve({ retry: true, offset: null }); };
        xhr.send(file.slice(offset, end));
      });
    }

    function step(offset) {
      return attempt(offset).then(function (r) {
        if (r.done) { ui.fill.style.width = '100%'; ui.status.textContent = S.uploaded || 'Uploaded'; ui.status.className = 'upstatus ok'; return true; }
        if (r.next != null) return step(r.next);
        if (r.retry) {
          if (retries++ > 8) { ui.status.textContent = S.uploadFail || 'Upload failed'; ui.status.className = 'upstatus err'; return false; }
          // Re-sync the offset from the server, then continue.
          return fetch('/c/' + encodeURIComponent(token) + '/upload-status?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
            .then(function (r2) { return r2.ok ? r2.json() : { offset: offset }; })
            .then(function (j) { return new Promise(function (res) { setTimeout(res, 800); }).then(function () { return step(j.offset || 0); }); })
            .catch(function () { ui.status.textContent = S.uploadFail || 'Upload failed'; ui.status.className = 'upstatus err'; return false; });
        }
        ui.status.textContent = (S.uploadFail || 'Upload failed') + (r.code ? ' (' + r.code + ')' : '');
        ui.status.className = 'upstatus err';
        return false;
      });
    }
    return step(0);
  }

  function runQueue() {
    if (!queue.length) {
      uploading = false;
      if (newFolderBtn) newFolderBtn.disabled = false;
      loadList();
      return;
    }
    uploading = true;
    if (newFolderBtn) newFolderBtn.disabled = true;
    var item = queue.shift();
    uploadOne(item).then(function () { runQueue(); });
  }

  function addFiles(fileList, withPaths) {
    var arr = Array.prototype.slice.call(fileList || []);
    // Cap the number of files accepted in one deposit (a single drop or
    // picker selection). The server's maxFiles / quota remain the hard limits.
    var perUpload = Math.max(0, Number(cfg.maxFilesPerUpload) || 0);
    if (perUpload > 0 && arr.length > perUpload) {
      arr = arr.slice(0, perUpload);
      try { window.alert((S.perUploadLimit || 'Max {v} files per upload').replace('{v}', perUpload)); } catch (_) {}
    }
    var base = curSub;
    arr.forEach(function (f) {
      var localRel = withPaths && f.webkitRelativePath ? f.webkitRelativePath : f.name;
      var rel = base ? base + '/' + localRel : localRel;
      queue.push({ file: f, relPath: rel });
    });
    if (arr.length && !uploading) runQueue();
  }

  // --- wire up ---
  if (pickFiles && input) pickFiles.addEventListener('click', function () { input.click(); });
  if (pickDir && inputDir) pickDir.addEventListener('click', function () { inputDir.click(); });
  if (input) input.addEventListener('change', function () { addFiles(input.files, false); input.value = ''; });
  if (inputDir) inputDir.addEventListener('change', function () { addFiles(inputDir.files, true); inputDir.value = ''; });
  if (drop) {
    drop.addEventListener('click', function (e) { if (e.target === input) return; input.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files, false);
    });
  }
  if (refreshBtn) refreshBtn.addEventListener('click', function () { loadList(); });
  if (newFolderBtn) newFolderBtn.addEventListener('click', createFolder);

  // Warn before leaving while an upload is running.
  window.addEventListener('beforeunload', function (e) {
    if (uploading) { e.preventDefault(); e.returnValue = ''; }
  });

  loadList();
  startPolling();
})();
