'use strict';
(function () {
  var BUILD = (window.__DX_PWA_RELEASE && window.__DX_PWA_RELEASE.build) || '2026.08.21-pwa409';
  var DB_NAME = 'direct-xfer-pwa';
  var HISTORY_STORE = 'history';
  var QUEUE_STORE = 'queue';
  var NETWORK_KEY = 'dx-pwa-network-errors-v1';
  var timelineTimer = 0;
  var widgetTimer = 0;
  var recognition = null;
  var recognitionActive = false;
  var timelineSeq = 0;
  var timelinePromise = null;
  var widgetSeq = 0;
  var widgetPromise = null;
  var widgetPreviousFocus = null;

  var TEXT = {
    fr: {
      timeline:'Timeline unifiée', timelineHint:'Activité serveur, transferts de cet appareil et incidents réseau dans un seul fil.',
      timelineAll:'Tout', timelineServer:'Serveur', timelineLocal:'Cet appareil', timelineNetwork:'Réseau', timelineSearch:'Rechercher dans la timeline…', timelineEmpty:'Aucun événement à afficher.',
      localSent:'Transfert envoyé', networkError:'Incident réseau', sourceServer:'Serveur', sourceLocal:'Appareil', sourceNetwork:'Réseau',
      networkHistory:'Historique des erreurs réseau', networkHistoryHint:'Échecs et reprises réseau persistants de cet appareil.', networkHistoryEmpty:'Aucun incident réseau enregistré.',
      voiceSearch:'Recherche vocale', voiceListening:'Écoute… parlez maintenant.', voiceUnsupported:'La reconnaissance vocale n’est pas disponible dans ce navigateur.', voiceDenied:'Accès au microphone refusé ou reconnaissance indisponible.', voiceNoSpeech:'Aucune parole détectée.', privateItem:'Fichier masqué',
      widgetTitle:'Widget rapide', widgetHint:'Vue compacte pour les transferts et les actions fréquentes.', widgetOpen:'Ouvrir le widget rapide', widgetClose:'Fermer', widgetTransfers:'Transferts actifs', widgetQueue:'En attente', widgetNetwork:'Réseau', widgetRecent:'Activité récente', widgetSend:'Envoyer', widgetActivity:'Activité', widgetVoice:'Recherche vocale', widgetRefresh:'Actualiser',
      online:'En ligne', offline:'Hors ligne', pending:'en attente'
    },
    en: {
      timeline:'Unified timeline', timelineHint:'Server activity, transfers from this device, and network incidents in one feed.',
      timelineAll:'All', timelineServer:'Server', timelineLocal:'This device', timelineNetwork:'Network', timelineSearch:'Search the timeline…', timelineEmpty:'No events to display.',
      localSent:'Transfer sent', networkError:'Network incident', sourceServer:'Server', sourceLocal:'Device', sourceNetwork:'Network',
      networkHistory:'Network error history', networkHistoryHint:'Persistent network failures and retries from this device.', networkHistoryEmpty:'No network incident recorded.',
      voiceSearch:'Voice search', voiceListening:'Listening… speak now.', voiceUnsupported:'Voice recognition is not available in this browser.', voiceDenied:'Microphone access denied or recognition unavailable.', voiceNoSpeech:'No speech detected.', privateItem:'Hidden file',
      widgetTitle:'Quick widget', widgetHint:'Compact view for transfers and frequent actions.', widgetOpen:'Open quick widget', widgetClose:'Close', widgetTransfers:'Active transfers', widgetQueue:'Waiting', widgetNetwork:'Network', widgetRecent:'Recent activity', widgetSend:'Send', widgetActivity:'Activity', widgetVoice:'Voice search', widgetRefresh:'Refresh',
      online:'Online', offline:'Offline', pending:'waiting'
    },
    es: {
      timeline:'Cronología unificada', timelineHint:'Actividad del servidor, transferencias de este dispositivo e incidentes de red en un solo flujo.',
      timelineAll:'Todo', timelineServer:'Servidor', timelineLocal:'Este dispositivo', timelineNetwork:'Red', timelineSearch:'Buscar en la cronología…', timelineEmpty:'No hay eventos para mostrar.',
      localSent:'Transferencia enviada', networkError:'Incidente de red', sourceServer:'Servidor', sourceLocal:'Dispositivo', sourceNetwork:'Red',
      networkHistory:'Historial de errores de red', networkHistoryHint:'Fallos y reintentos de red persistentes de este dispositivo.', networkHistoryEmpty:'No hay incidentes de red registrados.',
      voiceSearch:'Búsqueda por voz', voiceListening:'Escuchando… hable ahora.', voiceUnsupported:'El reconocimiento de voz no está disponible en este navegador.', voiceDenied:'Acceso al micrófono denegado o reconocimiento no disponible.', voiceNoSpeech:'No se detectó voz.', privateItem:'Archivo oculto',
      widgetTitle:'Widget rápido', widgetHint:'Vista compacta para transferencias y acciones frecuentes.', widgetOpen:'Abrir widget rápido', widgetClose:'Cerrar', widgetTransfers:'Transferencias activas', widgetQueue:'En espera', widgetNetwork:'Red', widgetRecent:'Actividad reciente', widgetSend:'Enviar', widgetActivity:'Actividad', widgetVoice:'Búsqueda por voz', widgetRefresh:'Actualizar',
      online:'En línea', offline:'Sin conexión', pending:'en espera'
    }
  };

  function lang() {
    var select = document.getElementById('lang-select');
    var value = select && select.value;
    if (!value) { try { value = localStorage.getItem('dx-lang') || localStorage.getItem('dx-pwa-lang'); } catch (_) {} }
    value = String(value || document.documentElement.lang || navigator.language || 'fr').slice(0, 2).toLowerCase();
    return TEXT[value] ? value : 'fr';
  }
  function tr(key) { return (TEXT[lang()] && TEXT[lang()][key]) || TEXT.fr[key] || key; }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function fmtBytes(bytes) { var n=Math.max(0,Number(bytes)||0),u=lang()==='fr'?['o','Ko','Mo','Go','To']:['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return (i?n.toFixed(n>=10?1:2):Math.round(n))+' '+u[i]; }
  function fmtTime(at) { try { return new Intl.DateTimeFormat(lang(), { dateStyle:'short', timeStyle:'short' }).format(new Date(Number(at)||Date.now())); } catch (_) { return new Date(Number(at)||Date.now()).toLocaleString(); } }
  function fetchJson(url, timeout) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ctrl.abort();}, timeout || 7000) : 0;
    return fetch(url, { credentials:'same-origin', cache:'no-store', headers:{Accept:'application/json'}, signal:ctrl ? ctrl.signal : undefined })
      .then(function(r){ if (timer) clearTimeout(timer); if(!r.ok) throw new Error('http-'+r.status); return r.json(); }, function(e){ if(timer) clearTimeout(timer); throw e; });
  }
  function privacyNamesEnabled(){try{return localStorage.getItem('dx-pwa-privacy-names')==='1';}catch(_){return false;}}
  function idbAll(storeName) {
    return new Promise(function(resolve){
      if (!window.indexedDB) return resolve([]);
      var req, settled=false, timer=setTimeout(function(){finish([]);},4500);
      function finish(rows,db){if(settled)return;settled=true;clearTimeout(timer);try{if(db)db.close();}catch(_){}resolve(Array.isArray(rows)?rows:[]);}
      try { req = indexedDB.open(DB_NAME); } catch (_) { return finish([]); }
      req.onerror = function(){ finish([]); };
      req.onblocked = function(){ finish([]); };
      req.onsuccess = function(){
        var db=req.result; if(!db.objectStoreNames.contains(storeName))return finish([],db);
        var tx,get;try{tx=db.transaction(storeName,'readonly');get=tx.objectStore(storeName).getAll();}catch(_){return finish([],db);}
        get.onsuccess=function(){finish(get.result,db);};
        get.onerror=function(){finish([],db);};
        tx.onabort=function(){finish([],db);};
      };
    });
  }
  function networkRows() {
    var rows=[];
    try { rows=JSON.parse(localStorage.getItem(NETWORK_KEY)||'[]'); } catch (_) {}
    if (!Array.isArray(rows) || !rows.length) {
      try { rows=(JSON.parse(localStorage.getItem('dx-pwa-error-log')||'[]')||[]).filter(function(x){return x&&x.category==='network';}); } catch (_) { rows=[]; }
    }
    return rows.filter(Boolean).slice(-100);
  }
  function activityTitle(e) { return String(e && (e.name || e.status || e.kind) || tr('sourceServer')); }
  function activityDetail(e) { return [e && e.direction==='up'?'⬆':e&&e.direction==='down'?'⬇':'', e&&e.bytes?fmtBytes(e.bytes):'', e&&e.detail||'', e&&e.ip||''].filter(Boolean).join(' · '); }

  function ensureTimeline() {
    if (document.getElementById('dx-unified-timeline')) return;
    var anchor=document.getElementById('server-activity-card'); if(!anchor||!anchor.parentNode) return;
    var section=document.createElement('section'); section.id='dx-unified-timeline'; section.className='card dx-unified-timeline'; section.setAttribute('data-pwa-panel','activity');
    section.innerHTML='<div class="dx-timeline-head"><div><h2>'+esc(tr('timeline'))+'</h2><p class="muted sm">'+esc(tr('timelineHint'))+'</p></div><span id="dx-timeline-count" class="count">0</span></div>'+
      '<div class="dx-timeline-tools"><input id="dx-timeline-search" type="search" autocomplete="off" placeholder="'+esc(tr('timelineSearch'))+'"><select id="dx-timeline-source"><option value="">'+esc(tr('timelineAll'))+'</option><option value="server">'+esc(tr('timelineServer'))+'</option><option value="local">'+esc(tr('timelineLocal'))+'</option><option value="network">'+esc(tr('timelineNetwork'))+'</option></select></div>'+
      '<div id="dx-timeline-list" class="dx-timeline-list" aria-live="polite"></div>'+
      '<details class="dx-network-history"><summary>'+esc(tr('networkHistory'))+' <span id="dx-network-history-count" class="count">0</span></summary><p class="muted sm">'+esc(tr('networkHistoryHint'))+'</p><div id="dx-network-history-list" class="dx-network-history-list"></div></details>';
    anchor.parentNode.insertBefore(section,anchor);
    document.getElementById('dx-timeline-search').addEventListener('input', renderTimeline);
    document.getElementById('dx-timeline-source').addEventListener('change', renderTimeline);
  }

  var timelineCache=[];
  async function loadTimeline() {
    ensureTimeline(); if(!document.getElementById('dx-unified-timeline')) return;
    if(timelinePromise)return timelinePromise;
    var seq=++timelineSeq;
    timelinePromise=Promise.all([
      fetchJson('/app/activity/recent?limit=500',7000).catch(function(){return{events:[]};}),
      idbAll(HISTORY_STORE), Promise.resolve(networkRows())
    ]).then(function(result){
      if(seq!==timelineSeq)return;
      var server=Array.isArray(result[0]&&result[0].events)?result[0].events:[], local=Array.isArray(result[1])?result[1]:[], network=Array.isArray(result[2])?result[2]:[];
      var hidden=privacyNamesEnabled(), rows=[];
      server.forEach(function(e){rows.push({id:'s:'+String(e.id||e.at||Math.random()),source:'server',at:Number(e.at)||0,icon:'●',title:hidden?String(e.status||e.kind||tr('sourceServer')):activityTitle(e),detail:hidden?[e&&e.direction==='up'?'⬆':e&&e.direction==='down'?'⬇':'',e&&e.bytes?fmtBytes(e.bytes):''].filter(Boolean).join(' · '):activityDetail(e)});});
      local.forEach(function(h){rows.push({id:'l:'+String(h.id||h.at||Math.random()),source:'local',at:Number(h.at)||0,icon:'↑',title:tr('localSent')+(h.name?' · '+(hidden?tr('privateItem'):h.name):''),detail:[h.size?fmtBytes(h.size):'',hidden?'':h.destination||'',h.rate?fmtBytes(h.rate)+'/s':''].filter(Boolean).join(' · ')});});
      network.forEach(function(n){var c=n.connection||{};rows.push({id:'n:'+String(n.id||n.at||Math.random()),source:'network',at:Number(n.at)||0,icon:'📡',title:tr('networkError')+(n.name?' · '+(hidden?tr('privateItem'):n.name):''),detail:[n.badge||n.code||'',n.hint||'',c.type||c.effectiveType||'',c.downlink?c.downlink+' Mb/s':''].filter(Boolean).join(' · ')});});
      rows.sort(function(a,b){return b.at-a.at;}); timelineCache=rows.slice(0,1000); renderTimeline(); renderNetworkHistory(network);
    }).finally(function(){timelinePromise=null;});
    return timelinePromise;
  }
  function renderTimeline() {
    var list=document.getElementById('dx-timeline-list'); if(!list) return;
    var q=String(document.getElementById('dx-timeline-search')&&document.getElementById('dx-timeline-search').value||'').trim().toLowerCase();
    var source=String(document.getElementById('dx-timeline-source')&&document.getElementById('dx-timeline-source').value||'');
    var rows=timelineCache.filter(function(x){return (!source||x.source===source)&&(!q||(x.title+' '+x.detail).toLowerCase().indexOf(q)!==-1);}).slice(0,200);
    list.innerHTML='';
    if(!rows.length){list.innerHTML='<p class="muted sm">'+esc(tr('timelineEmpty'))+'</p>';}
    rows.forEach(function(x){var row=document.createElement('div');row.className='dx-timeline-row dx-source-'+x.source;row.innerHTML='<span class="dx-timeline-icon">'+esc(x.icon)+'</span><div class="dx-timeline-main"><strong>'+esc(x.title)+'</strong><div class="muted sm">'+esc(x.detail)+'</div></div><div class="dx-timeline-side"><span class="dx-source-pill">'+esc(x.source==='server'?tr('sourceServer'):x.source==='network'?tr('sourceNetwork'):tr('sourceLocal'))+'</span><time title="'+esc(fmtTime(x.at))+'">'+esc(fmtTime(x.at))+'</time></div>';list.appendChild(row);});
    var count=document.getElementById('dx-timeline-count');if(count)count.textContent=String(rows.length);
  }
  function renderNetworkHistory(rows) {
    var list=document.getElementById('dx-network-history-list'), count=document.getElementById('dx-network-history-count'); if(!list)return;
    rows=(Array.isArray(rows)?rows:networkRows()).slice().sort(function(a,b){return (Number(b.at)||0)-(Number(a.at)||0);}).slice(0,50); list.innerHTML='';if(count)count.textContent=String(rows.length);
    if(!rows.length){list.innerHTML='<p class="muted sm">'+esc(tr('networkHistoryEmpty'))+'</p>';return;}
    var hidden=privacyNamesEnabled();
    rows.forEach(function(n){var c=n.connection||{},row=document.createElement('div');row.className='dx-network-error-row';row.innerHTML='<div><strong>'+esc(hidden&&n.name?tr('privateItem'):(n.name||tr('networkError')))+'</strong><div class="muted sm">'+esc([n.badge||n.code||'',n.hint||'',c.type||c.effectiveType||'',c.rtt?c.rtt+' ms':'',c.downlink?c.downlink+' Mb/s':'',n.attempt?'#'+n.attempt:''].filter(Boolean).join(' · '))+'</div></div><time>'+esc(fmtTime(n.at))+'</time>';list.appendChild(row);});
  }

  function activatePanel(name) { var button=document.querySelector('[data-pwa-nav="'+name+'"]'); if(button) button.click(); }
  function voiceButton() {
    var row=document.querySelector('.share-search-row'), input=document.getElementById('share-global-search'); if(!row||!input||document.getElementById('dx-voice-search'))return;
    var btn=document.createElement('button');btn.id='dx-voice-search';btn.type='button';btn.className='btn ghost sm dx-voice-search';btn.title=tr('voiceSearch');btn.setAttribute('aria-label',tr('voiceSearch'));btn.textContent='🎙';row.insertBefore(btn,document.getElementById('share-global-search-btn'));
    btn.addEventListener('click', startVoiceSearch);
  }
  function startVoiceSearch() {
    activatePanel('shares');
    setTimeout(function(){
      var input=document.getElementById('share-global-search'), btn=document.getElementById('dx-voice-search'); if(!input)return;
      var Ctor=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!Ctor){window.alert(tr('voiceUnsupported'));return;}
      if(recognitionActive&&recognition){try{recognition.stop();}catch(_){}return;}
      try {
        recognition=new Ctor();recognition.lang=lang()==='fr'?'fr-CA':lang()==='es'?'es-ES':'en-US';recognition.continuous=false;recognition.interimResults=true;recognition.maxAlternatives=1;
        var originalPlaceholder=input.getAttribute('placeholder')||'';
        recognition.onstart=function(){recognitionActive=true;if(btn){btn.classList.add('is-listening');btn.textContent='⏺';}input.placeholder=tr('voiceListening');};
        recognition.onresult=function(event){var parts=[];for(var i=event.resultIndex;i<event.results.length;i++){var piece=event.results[i]&&event.results[i][0]&&event.results[i][0].transcript;if(piece)parts.push(piece);}var text=parts.join(' ').replace(/\s+/g,' ').trim();if(text)input.value=text;if(event.results[event.results.length-1]&&event.results[event.results.length-1].isFinal){var search=document.getElementById('share-global-search-btn');if(search)search.click();}};
        recognition.onerror=function(event){var code=String(event&&event.error||'');if(code==='aborted')return;if(code==='no-speech'){window.alert(tr('voiceNoSpeech'));return;}window.alert(tr('voiceDenied'));};
        recognition.onend=function(){recognitionActive=false;if(btn){btn.classList.remove('is-listening');btn.textContent='🎙';}input.placeholder=originalPlaceholder;recognition=null;};
        recognition.start();
      } catch (_) { window.alert(tr('voiceDenied')); }
    },180);
  }

  function ensureWidgetSettings() {
    var grid=document.querySelector('#settings-card .settings-grid'); if(!grid||document.getElementById('dx-widget-open'))return;
    var row=document.createElement('div');row.className='setting-row dx-widget-setting';row.innerHTML='<div><strong>'+esc(tr('widgetTitle'))+'</strong><p class="muted sm">'+esc(tr('widgetHint'))+'</p></div><button id="dx-widget-open" type="button" class="btn ghost sm">'+esc(tr('widgetOpen'))+'</button>';grid.appendChild(row);document.getElementById('dx-widget-open').addEventListener('click',openWidget);
  }
  function ensureWidget() {
    if(document.getElementById('dx-quick-widget'))return document.getElementById('dx-quick-widget');
    var overlay=document.createElement('div');overlay.id='dx-quick-widget';overlay.className='dx-widget-overlay hidden';overlay.innerHTML='<section class="dx-widget-card" role="dialog" aria-modal="true" aria-labelledby="dx-widget-title"><div class="dx-widget-head"><div><h2 id="dx-widget-title">'+esc(tr('widgetTitle'))+'</h2><p class="muted sm">'+esc(tr('widgetHint'))+'</p></div><button id="dx-widget-close" class="btn ghost sm" type="button" aria-label="'+esc(tr('widgetClose'))+'">✕</button></div><div class="dx-widget-metrics"><div><span>'+esc(tr('widgetTransfers'))+'</span><strong id="dx-widget-transfers">—</strong></div><div><span>'+esc(tr('widgetQueue'))+'</span><strong id="dx-widget-queue">—</strong></div><div><span>'+esc(tr('widgetNetwork'))+'</span><strong id="dx-widget-network">—</strong></div></div><div><strong>'+esc(tr('widgetRecent'))+'</strong><div id="dx-widget-recent" class="dx-widget-recent"></div></div><div class="dx-widget-actions"><button type="button" class="btn" data-dx-widget-action="send">'+esc(tr('widgetSend'))+'</button><button type="button" class="btn ghost" data-dx-widget-action="activity">'+esc(tr('widgetActivity'))+'</button><button type="button" class="btn ghost" data-dx-widget-action="voice">🎙 '+esc(tr('widgetVoice'))+'</button><button type="button" class="btn ghost" id="dx-widget-refresh">↻ '+esc(tr('widgetRefresh'))+'</button></div><small class="muted">'+esc(BUILD)+'</small></section>';document.body.appendChild(overlay);
    document.getElementById('dx-widget-close').addEventListener('click',closeWidget);document.getElementById('dx-widget-refresh').addEventListener('click',refreshWidget);
    overlay.addEventListener('click',function(e){var a=e.target.closest('[data-dx-widget-action]');if(!a)return;var action=a.getAttribute('data-dx-widget-action');closeWidget();if(action==='voice')startVoiceSearch();else activatePanel(action);});
    return overlay;
  }
  function openWidget(){var overlay=ensureWidget();widgetPreviousFocus=document.activeElement;overlay.classList.remove('hidden');var close=document.getElementById('dx-widget-close');if(close)close.focus();refreshWidget();clearInterval(widgetTimer);widgetTimer=setInterval(refreshWidget,5000);}
  function closeWidget(){var overlay=document.getElementById('dx-quick-widget');widgetSeq++;if(overlay)overlay.classList.add('hidden');clearInterval(widgetTimer);widgetTimer=0;var recent=document.getElementById('dx-widget-recent');if(recent)recent.innerHTML='';if(widgetPreviousFocus&&typeof widgetPreviousFocus.focus==='function')try{widgetPreviousFocus.focus();}catch(_){}widgetPreviousFocus=null;}
  async function refreshWidget(){
    var overlay=document.getElementById('dx-quick-widget');if(!overlay||overlay.classList.contains('hidden'))return;if(widgetPromise)return widgetPromise;var seq=++widgetSeq;
    widgetPromise=Promise.all([fetchJson('/app/activity/transfers',5000).catch(function(){return{transfers:[]};}),idbAll(QUEUE_STORE),fetchJson('/app/activity/recent?limit=3',5000).catch(function(){return{events:[]};})]).then(function(result){if(seq!==widgetSeq||overlay.classList.contains('hidden'))return;
      var active=(result[0].transfers||[]).length, queue=(result[1]||[]).filter(function(x){return x&&['waiting','waiting-network','sending','paused','error'].indexOf(x.state)!==-1;}).length;
      var c=navigator.connection||navigator.mozConnection||navigator.webkitConnection, net=navigator.onLine===false?tr('offline'):tr('online')+(c&&c.effectiveType?' · '+String(c.effectiveType).toUpperCase():'');
      var set=function(id,v){var n=document.getElementById(id);if(n)n.textContent=String(v);};set('dx-widget-transfers',active);set('dx-widget-queue',queue);set('dx-widget-network',net);
      var hidden=privacyNamesEnabled(),recent=document.getElementById('dx-widget-recent');if(recent){recent.innerHTML='';(result[2].events||[]).slice(0,3).forEach(function(e){var row=document.createElement('div');row.className='dx-widget-recent-row';row.innerHTML='<strong>'+esc(hidden?String(e.status||e.kind||tr('sourceServer')):activityTitle(e))+'</strong><span>'+esc(fmtTime(e.at))+'</span>';recent.appendChild(row);});}
    }).finally(function(){widgetPromise=null;if(seq!==widgetSeq&&overlay&&!overlay.classList.contains('hidden'))setTimeout(refreshWidget,0);});return widgetPromise;
  }

  function onPanelChange() {
    if(document.body.getAttribute('data-pwa-active-panel')==='activity')loadTimeline();
  }
  function init() {
    ensureTimeline(); voiceButton(); ensureWidgetSettings();
    var mo=new MutationObserver(onPanelChange);mo.observe(document.body,{attributes:true,attributeFilter:['data-pwa-active-panel']});
    var langSelect=document.getElementById('lang-select');if(langSelect)langSelect.addEventListener('change',function(){setTimeout(function(){location.reload();},0);});
    var privacyToggle=document.getElementById('privacy-names');if(privacyToggle)privacyToggle.addEventListener('change',function(){
      // Remove already-rendered names immediately; the asynchronous refresh then
      // rebuilds the feed using the new privacy state.
      timelineCache=[];renderTimeline();renderNetworkHistory(networkRows());var recent=document.getElementById('dx-widget-recent');if(recent)recent.innerHTML='';loadTimeline();refreshWidget();
    });
    onPanelChange();clearInterval(timelineTimer);timelineTimer=setInterval(function(){if(document.body.getAttribute('data-pwa-active-panel')==='activity'&&document.visibilityState!=='hidden')loadTimeline();},10000);
    var action=new URLSearchParams(location.search).get('action')||'';
    if(action==='activity')setTimeout(function(){activatePanel('activity');},220);
    else if(action==='voice-search')setTimeout(startVoiceSearch,500);
    else if(action==='widget')setTimeout(openWidget,400);
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.getElementById('dx-quick-widget')&&!document.getElementById('dx-quick-widget').classList.contains('hidden'))closeWidget();});
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'&&recognitionActive&&recognition)try{recognition.stop();}catch(_){} });
    window.addEventListener('pagehide',function(){timelineSeq++;widgetSeq++;clearInterval(timelineTimer);clearInterval(widgetTimer);if(recognitionActive&&recognition)try{recognition.stop();}catch(_){};});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
