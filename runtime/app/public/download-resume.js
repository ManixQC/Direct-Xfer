'use strict';

// Persistent, same-origin download manager for public Direct-Xfer pages.
// Completed chunks live in IndexedDB, so closing/reopening the browser or an
// installed PWA never forces the already-received bytes to be downloaded again.
(function () {
  if (!('indexedDB' in window) || !('fetch' in window) || !('Blob' in window)) return;

  const lang = (document.documentElement.lang || 'en').slice(0, 2);
  const STRINGS = {
    fr:{ title:'Téléchargements', resume:'Reprendre', pause:'Pause', cancel:'Supprimer', save:'Enregistrer', preparing:'Préparation…', elsewhere:'Actif dans un autre onglet…', paused:'En pause', failed:'Interrompu', ready:'Prêt', storage:'Espace de stockage du navigateur insuffisant.', changed:'Le fichier a changé; reprise redémarrée.', native:'Ce lien utilise le téléchargement standard.' },
    en:{ title:'Downloads', resume:'Resume', pause:'Pause', cancel:'Remove', save:'Save', preparing:'Preparing…', elsewhere:'Active in another tab…', paused:'Paused', failed:'Interrupted', ready:'Ready', storage:'Not enough browser storage.', changed:'The file changed; restarting the download.', native:'This link uses the standard download.' },
    es:{ title:'Descargas', resume:'Reanudar', pause:'Pausa', cancel:'Eliminar', save:'Guardar', preparing:'Preparando…', elsewhere:'Activa en otra pestaña…', paused:'En pausa', failed:'Interrumpida', ready:'Lista', storage:'No hay suficiente almacenamiento del navegador.', changed:'El archivo cambió; se reinicia la descarga.', native:'Este enlace usa la descarga estándar.' },
  };
  const T = STRINGS[lang] || STRINGS.en;
  const DB_NAME = 'direct-xfer-downloads-v1';
  const TASKS = 'tasks', CHUNKS = 'chunks';
  const CHUNK_BYTES = 8 * 1024 * 1024;
  const DB_TIMEOUT_MS = 8000;
  const LEASE_MS = 45000;
  const LEASE_HEARTBEAT_MS = 12000;
  const active = new Map();
  const leaseTimers = new Map();
  const instanceId = randomId();
  let panel = null, list = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      let req, settled = false;
      const timer = setTimeout(() => {
        if (settled) return; settled = true; reject(new Error('indexeddb-timeout'));
      }, DB_TIMEOUT_MS);
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TASKS)) db.createObjectStore(TASKS, { keyPath:'id' });
        if (!db.objectStoreNames.contains(CHUNKS)) {
          const store = db.createObjectStore(CHUNKS, { keyPath:['taskId','index'] });
          store.createIndex('taskId', 'taskId', { unique:false });
        }
      };
      req.onsuccess = () => {
        if (settled) { try { req.result.close(); } catch (_) {} return; }
        settled = true; clearTimeout(timer); resolve(req.result);
      };
      req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error || new Error('indexeddb')); } };
      req.onblocked = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('indexeddb-blocked')); } };
    });
  }
  async function transaction(storeNames, mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let value, settled = false;
        const timer = setTimeout(() => {
          if (settled) return; settled = true;
          try { tx.abort(); } catch (_) {}
          reject(new Error('indexeddb-transaction-timeout'));
        }, DB_TIMEOUT_MS);
        try { value = run(tx); }
        catch (error) { settled = true; clearTimeout(timer); try { tx.abort(); } catch (_) {} reject(error); return; }
        tx.oncomplete = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        tx.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(tx.error || new Error('indexeddb')); } };
        tx.onabort = () => { if (!settled) { settled = true; clearTimeout(timer); reject(tx.error || new Error('indexeddb-abort')); } };
      });
    } finally { db.close(); }
  }
  function requestValue(request) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('indexeddb-request-timeout')); } }, DB_TIMEOUT_MS);
      request.onsuccess = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(request.result); } };
      request.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(request.error || new Error('indexeddb')); } };
    });
  }
  function saveTask(task) { return transaction([TASKS], 'readwrite', (tx) => tx.objectStore(TASKS).put(task)); }
  async function updateTaskLease(id, claim) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction([TASKS], 'readwrite');
        const store = tx.objectStore(TASKS);
        let result = null, settled = false;
        const timer = setTimeout(() => {
          if (settled) return; settled = true;
          try { tx.abort(); } catch (_) {}
          reject(new Error('indexeddb-lease-timeout'));
        }, DB_TIMEOUT_MS);
        const req = store.get(id);
        req.onsuccess = () => {
          const task = req.result;
          const now = Date.now();
          if (!task) return;
          if (task.leaseOwner && task.leaseOwner !== instanceId && Number(task.leaseUntil || 0) > now) return;
          if (!claim && task.leaseOwner !== instanceId) return;
          task.leaseOwner = instanceId; task.leaseUntil = now + LEASE_MS;
          store.put(task); result = task;
        };
        req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error || new Error('indexeddb-lease')); } };
        tx.oncomplete = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        tx.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(tx.error || new Error('indexeddb-lease')); } };
        tx.onabort = () => { if (!settled) { settled = true; clearTimeout(timer); reject(tx.error || new Error('indexeddb-lease-abort')); } };
      });
    } finally { db.close(); }
  }
  function claimTask(id) { return updateTaskLease(id, true); }
  function renewTaskLease(id) { return updateTaskLease(id, false); }
  function stopLeaseHeartbeat(id) {
    const timer = leaseTimers.get(id); if (timer) clearInterval(timer); leaseTimers.delete(id);
  }
  function clearTaskLease(task) {
    if (!task) return task;
    delete task.leaseOwner; delete task.leaseUntil;
    return task;
  }
  async function allTasks() {
    const db = await openDb();
    try {
      const tx = db.transaction([TASKS], 'readonly');
      return await requestValue(tx.objectStore(TASKS).getAll());
    } finally { db.close(); }
  }
  function saveChunk(taskId, index, blob) {
    return transaction([CHUNKS], 'readwrite', (tx) => tx.objectStore(CHUNKS).put({ taskId, index, blob }));
  }
  async function taskChunks(taskId) {
    const db = await openDb();
    try {
      const tx = db.transaction([CHUNKS], 'readonly');
      const rows = await requestValue(tx.objectStore(CHUNKS).index('taskId').getAll(IDBKeyRange.only(taskId)));
      return rows.sort((a, b) => a.index - b.index);
    } finally { db.close(); }
  }
  async function removeTask(id) {
    const controller = active.get(id); if (controller) controller.abort(); active.delete(id);
    stopLeaseHeartbeat(id);
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction([TASKS, CHUNKS], 'readwrite');
        tx.objectStore(TASKS).delete(id);
        const index = tx.objectStore(CHUNKS).index('taskId');
        const cursor = index.openKeyCursor(IDBKeyRange.only(id));
        cursor.onsuccess = () => { const row = cursor.result; if (row) { tx.objectStore(CHUNKS).delete(row.primaryKey); row.continue(); } };
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    requestRender();
  }
  async function clearAllTasks() {
    active.forEach((controller) => { try { controller.abort(); } catch (_) {} });
    active.clear(); leaseTimers.forEach((timer) => clearInterval(timer)); leaseTimers.clear();
    await transaction([TASKS, CHUNKS], 'readwrite', (tx) => {
      tx.objectStore(TASKS).clear(); tx.objectStore(CHUNKS).clear();
    });
    requestRender();
  }
  async function clearTaskChunks(id) {
    const rows = await taskChunks(id);
    if (!rows.length) return;
    return transaction([CHUNKS], 'readwrite', (tx) => rows.forEach((row) => tx.objectStore(CHUNKS).delete([id, row.index])));
  }
  function randomId() {
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    return Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  }
  function filenameFrom(headers, fallback) {
    const raw = headers.get('content-disposition') || '';
    const utf = /filename\*=UTF-8''([^;]+)/i.exec(raw);
    if (utf) { try { return decodeURIComponent(utf[1]).slice(0, 240); } catch (_) {} }
    return String(fallback || 'download').replace(/[\\/]+/g, '_').slice(0, 240);
  }
  function human(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < 1024) return n + ' B';
    const units = ['KB','MB','GB','TB']; let value = n, unit = -1;
    do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
    return value.toFixed(value >= 10 ? 1 : 2) + ' ' + units[unit];
  }
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('aside'); panel.className = 'dx-resume-panel';
    const head = document.createElement('div'); head.className = 'dx-resume-head'; head.textContent = T.title;
    list = document.createElement('div'); list.className = 'dx-resume-list';
    panel.append(head, list); document.body.appendChild(panel); return panel;
  }
  async function render() {
    const tasks = (await allTasks()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    ensurePanel(); list.textContent = ''; panel.hidden = !tasks.length;
    tasks.forEach((task) => {
      const row = document.createElement('div'); row.className = 'dx-resume-row';
      const name = document.createElement('strong'); name.textContent = task.name || 'download';
      const meta = document.createElement('div'); meta.className = 'dx-resume-meta';
      const pct = task.total ? Math.min(100, Math.floor((Number(task.offset) || 0) * 100 / task.total)) : 0;
      meta.textContent = `${human(task.offset)} / ${human(task.total)} · ${task.status === 'ready' ? T.ready : task.status === 'failed' ? (task.error || T.failed) : task.status === 'paused' ? T.paused : pct + '%'}`;
      const bar = document.createElement('progress'); bar.max = Math.max(1, task.total || 1); bar.value = Math.max(0, task.offset || 0);
      const actions = document.createElement('div'); actions.className = 'dx-resume-actions';
      const primary = document.createElement('button'); primary.type = 'button'; primary.className = 'btn ghost sm';
      const leasedElsewhere = task.leaseOwner && task.leaseOwner !== instanceId && Number(task.leaseUntil || 0) > Date.now();
      primary.textContent = task.status === 'ready' ? T.save : active.has(task.id) ? T.pause : leasedElsewhere ? T.elsewhere : T.resume;
      primary.disabled = !!leasedElsewhere;
      primary.onclick = () => task.status === 'ready' ? finalizeSave(task) : active.has(task.id) ? pause(task) : run(task);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn danger sm'; remove.textContent = T.cancel;
      remove.onclick = () => removeTask(task.id);
      actions.append(primary, remove); row.append(name, meta, bar, actions); list.appendChild(row);
    });
  }
  function requestRender() { render().catch(function () {}); }
  async function pause(task) {
    const controller = active.get(task.id); if (controller) controller.abort(); active.delete(task.id);
    stopLeaseHeartbeat(task.id);
    task.status = 'paused'; task.updatedAt = Date.now(); clearTaskLease(task); await saveTask(task); requestRender();
  }
  async function finalizeSave(task) {
    let handle = null;
    if (typeof window.showSaveFilePicker === 'function') {
      try { handle = await window.showSaveFilePicker({ suggestedName:task.name || 'download' }); }
      catch (error) { if (error && error.name === 'AbortError') return; }
    }
    try {
      const rows = await taskChunks(task.id);
      const storedBytes = rows.reduce((sum, row) => sum + Number(row.blob && row.blob.size || 0), 0);
      if (storedBytes !== task.total) throw new Error(T.failed);
      if (handle) {
        const writable = await handle.createWritable();
        try { for (const row of rows) await writable.write(row.blob); await writable.close(); }
        catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
      } else {
        const blob = new Blob(rows.map((row) => row.blob), { type:'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = task.name || 'download'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      await removeTask(task.id);
    } catch (error) {
      task.status = 'ready'; task.error = error && error.message || T.failed; task.updatedAt = Date.now();
      await saveTask(task); requestRender();
    }
  }
  async function run(task) {
    if (active.has(task.id)) return;
    try { task = await claimTask(task.id); }
    catch (error) {
      task.status = 'failed'; task.error = error.message || T.failed; task.updatedAt = Date.now();
      try { await saveTask(task); } catch (_) {} requestRender(); return;
    }
    if (!task) { requestRender(); return; }
    const controller = new AbortController(); active.set(task.id, controller);
    let leaseLost = false;
    const ensureLease = async () => {
      const current = await renewTaskLease(task.id);
      if (!current) return false;
      task.leaseOwner = current.leaseOwner; task.leaseUntil = current.leaseUntil;
      return true;
    };
    leaseTimers.set(task.id, setInterval(() => {
      ensureLease().then((ok) => { if (!ok) { leaseLost = true; try { controller.abort(); } catch (_) {} } })
        .catch(() => { leaseLost = true; try { controller.abort(); } catch (_) {} });
    }, LEASE_HEARTBEAT_MS));
    try {
      task.status = 'running'; task.error = ''; task.updatedAt = Date.now(); await saveTask(task); requestRender();
      while (task.offset < task.total) {
        if (!(await ensureLease())) { leaseLost = true; throw new DOMException('lease-lost', 'AbortError'); }
        const start = task.offset, end = Math.min(task.total - 1, start + CHUNK_BYTES - 1);
        const headers = { Range:`bytes=${start}-${end}`, 'X-Direct-Xfer-Resume-Id':task.id };
        if (task.etag) headers['If-Range'] = task.etag;
        const response = await fetch(task.url, { headers, credentials:'same-origin', cache:'no-store', signal:controller.signal });
        if (/text\/html/i.test(response.headers.get('content-type') || '') || response.headers.get('x-direct-xfer-resumable') !== '1') {
          throw Object.assign(new Error(T.native), { native:true });
        }
        if (response.status === 409) {
          let error = {}; try { error = await response.json(); } catch (_) {}
          if (error.error === 'resume-unavailable-one-time') throw Object.assign(new Error(T.native), { native:true });
          if (error.error === 'resume-id-conflict' || error.error === 'resume-already-complete') {
            const restartAnchor = { href:task.url, getAttribute:(name) => name === 'download' ? task.name : null };
            await removeTask(task.id);
            await begin(restartAnchor);
            return;
          }
          throw new Error(error.error || 'resume-conflict');
        }
        if (!(response.status === 206 || response.status === 200)) throw new Error('HTTP ' + response.status);
        const responseResumeId = String(response.headers.get('x-direct-xfer-resume-id') || '').toLowerCase();
        if (responseResumeId && responseResumeId !== task.id) throw new Error('resume-id-mismatch');
        if (response.status === 200) {
          // If-Range mismatch means the source changed. Do not materialize an
          // unexpected full multi-gigabyte body in memory; cancel it and restart
          // cleanly with the new validator/size.
          try { if (response.body) await response.body.cancel(); } catch (_) {}
          const replacementTotal = Number(response.headers.get('content-length'));
          if (!Number.isSafeInteger(replacementTotal) || replacementTotal <= 0) throw new Error('invalid-file-size');
          await clearTaskChunks(task.id);
          task.total = replacementTotal; task.offset = 0;
          task.etag = response.headers.get('etag') || '';
          task.name = filenameFrom(response.headers, task.name);
          task.updatedAt = Date.now(); await saveTask(task); requestRender();
          continue;
        }
        const contentRange = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(response.headers.get('content-range') || ''));
        if (!contentRange || Number(contentRange[1]) !== start || Number(contentRange[2]) !== end || Number(contentRange[3]) !== task.total) {
          try { if (response.body) await response.body.cancel(); } catch (_) {}
          throw new Error('invalid-content-range');
        }
        const blob = await response.blob();
        const expected = end - start + 1;
        if (blob.size !== expected) throw new Error('incomplete-range');
        if (!(await ensureLease())) { leaseLost = true; throw new DOMException('lease-lost', 'AbortError'); }
        await saveChunk(task.id, Math.floor(start / CHUNK_BYTES), blob);
        task.offset = start + blob.size; task.updatedAt = Date.now(); task.etag = response.headers.get('etag') || task.etag;
        await saveTask(task); requestRender();
      }
      task.status = 'ready'; task.updatedAt = Date.now(); clearTaskLease(task);
      await saveTask(task); active.delete(task.id); stopLeaseHeartbeat(task.id); requestRender();
    } catch (error) {
      active.delete(task.id); stopLeaseHeartbeat(task.id);
      if (error && error.name === 'AbortError') { if (leaseLost) requestRender(); return; }
      if (error && error.native) {
        const nativeUrl = task.url; await removeTask(task.id); location.href = nativeUrl; return;
      }
      task.status = 'failed'; task.error = error && /quota|space/i.test(String(error.name) + String(error.message)) ? T.storage : (error.message || T.failed);
      task.updatedAt = Date.now(); clearTaskLease(task); await saveTask(task); requestRender();
    }
  }
  async function begin(anchor) {
    const url = new URL(anchor.href, location.href);
    let head;
    try { head = await fetch(url.href, { method:'HEAD', credentials:'same-origin', cache:'no-store' }); }
    catch (_) { location.href = url.href; return; }
    if (!head.ok || head.headers.get('x-direct-xfer-resumable') !== '1') { location.href = url.href; return; }
    const total = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(total) || total <= 0) { location.href = url.href; return; }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const available = Math.max(0, Number(estimate.quota || 0) - Number(estimate.usage || 0));
        if (available && available < total * 1.05) { location.href = url.href; return; }
      } catch (_) {}
    }
    const etag = head.headers.get('etag') || '';
    const existing = (await allTasks()).find((row) => row && row.url === url.href && row.total === total && row.etag === etag);
    if (existing) { requestRender(); if (existing.status !== 'ready') run(existing); return; }
    const task = {
      id:randomId(), url:url.href, name:filenameFrom(head.headers, anchor.getAttribute('download') || url.pathname.split('/').pop()),
      total, offset:0, etag, status:'paused', createdAt:Date.now(), updatedAt:Date.now(),
    };
    await saveTask(task); requestRender(); run(task);
  }
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest && event.target.closest('a[download]');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    let url; try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin || /(?:\.zip$|\/zip(?:\/|$)|\/enc$)/.test(url.pathname)) return;
    event.preventDefault(); begin(anchor).catch(() => { location.href = url.href; });
  });
  window.addEventListener('pageshow', () => { requestRender(); });
  window.DirectXferDownloads = Object.freeze({ clearAll:clearAllTasks });
  setInterval(() => { render().catch(function () {}); }, 15000);
  requestRender();
})();
