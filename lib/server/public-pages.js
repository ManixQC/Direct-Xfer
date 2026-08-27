'use strict';

/**
 * Public share page renderer.
 *
 * Keeps the large HTML/i18n rendering surface out of server.js while leaving
 * filesystem access, authorization and routing in the main server orchestrator.
 */
function createPublicPages(deps) {
  const {
    APP_NAME, APP_VERSION, APP_YEAR,
    requestContext, recipientByToken,
    pubIp, linkPrefix, shareEffectiveExpiry, getSettings, clientIp, parseCookies,
    receptionThreadEnabled, parseMaxVisitors, zipAllowed,
    esc, jsonForScript, formatBytes, encodePath,
    previewInfo, subtitleTracksFor, renderKind, renderMarkdown,
  } = deps;

const PAGE_STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  background:#0f1220;color:#e7e9f3;min-height:100vh;display:flex;flex-direction:column}
a{color:#8ab4ff}
.wrap{max-width:1240px;margin:0 auto;padding:32px 20px;width:100%;flex:1}
.card{background:#1a1e33;border:1px solid #2a3050;border-radius:14px;padding:28px;margin:18px 0}
h1{font-size:1.4rem;margin:0 0 4px;word-break:break-word}
.muted{color:#9aa3c7;font-size:.9rem}
.btn{display:inline-block;background:#3b6ef6;color:#fff;text-decoration:none;
  padding:12px 22px;border-radius:10px;font-weight:600;margin-top:8px}
.btn:hover{background:#2f5de0}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #2a3050;font-size:.92rem}
th{color:#9aa3c7;font-weight:600}
td.size{white-space:nowrap;color:#9aa3c7}
.crumbs{margin:0 0 8px;font-size:.9rem;color:#9aa3c7;word-break:break-all}
.crumbs .crumb{color:#8ab4ff;text-decoration:none}
.crumbs .crumb:hover{text-decoration:underline}
.crumbs .crumb.active{color:#9aa3c7;font-weight:600}
.collab-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:6px 0 10px}
.collab-bar-actions{display:flex;gap:8px;flex-wrap:wrap}
.collab-list{display:flex;flex-direction:column;gap:2px;margin:6px 0 14px;border:1px solid #2a3050;border-radius:12px;overflow:hidden}
.cl-row{display:flex;align-items:center;gap:10px;padding:9px 12px;background:#151a2e;border-bottom:1px solid #222846}
.cl-row:last-child{border-bottom:none}
.cl-row.cl-up{background:#12172a}
.cl-ico{flex:0 0 auto;width:1.3em;text-align:center}
.cl-name{flex:1;min-width:0;word-break:break-all;color:#e8ebfb;text-decoration:none}
a.cl-name:hover{text-decoration:underline;color:#8ab4ff}
.cl-size{flex:0 0 auto;white-space:nowrap;font-size:.82rem;margin-right:4px}
.cl-empty{padding:16px;text-align:center}
.ico{display:inline-block;width:1.2em;text-align:center;margin-right:6px}
.brandbar{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 20px;border-bottom:1px solid #2a3050}
.bb-name{font-weight:700;font-size:1.05rem;color:#8ab4ff;display:inline-flex;align-items:center;gap:8px}
.bb-logo{width:26px;height:26px}
.langsel{display:inline-flex;align-items:center;gap:5px;font-size:.8rem;white-space:nowrap}
.langsel-ico{opacity:.7;margin-right:1px}
.langsel a{color:#9aa3c7;text-decoration:none;padding:3px 9px;border-radius:8px;border:1px solid #2a3050}
.langsel a:hover{color:#e7e9f3;border-color:#3b6ef6}
.langsel .active{color:#fff;font-weight:700;padding:3px 9px;border-radius:8px;background:#3b6ef6;border:1px solid #3b6ef6}
.langsel a.pending{color:#ffd166;border-color:#ffd166}
.langsel a.pending::after{content:'';display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:#ffd166;vertical-align:middle}
.brandbar-tools{display:inline-flex;align-items:center;gap:8px}
.themesel{background:#0f1220;color:#e7e9f3;border:1px solid #2a3050;border-radius:8px;padding:4px 8px;font-size:.8rem;cursor:pointer}
footer{text-align:center;padding:16px;color:#6b7398;font-size:.8rem}
.preview{margin:14px 0;display:flex;justify-content:center;position:relative}
.preview img,.preview video{max-width:100%;max-height:70vh;border-radius:12px;background:#0d1226;border:1px solid #2a3050}
.preview-audio{display:block}
.preview-audio audio{width:100%}
.wm-overlay{position:absolute;inset:0;pointer-events:none;background-repeat:repeat;background-position:center;border-radius:12px;mix-blend-mode:screen;z-index:2}
.legal-banner{display:flex;align-items:center;justify-content:center;gap:8px;
  padding:9px 16px;background:#3a2a12;color:#ffd8a8;border-bottom:1px solid #5a4320;
  font-size:.85rem;font-weight:600;text-align:center}
.legal-ico{flex:none}
.render-card{max-width:900px}
.pdf-preview-shell{margin-top:14px;height:min(78vh,900px);min-height:520px;border:1px solid #2a3050;border-radius:12px;overflow:hidden;background:#0d1226}
.pdf-preview-frame{display:block;width:100%;height:100%;border:0;background:#fff}
.render-out{margin-top:14px}
pre.code{background:#0d1226;border:1px solid #2a3050;border-radius:10px;padding:14px 16px;
  overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;
  line-height:1.5;color:#c8d0f0;white-space:pre;tab-size:2}
pre.code code{font:inherit;color:inherit;background:none;padding:0}
.tok-c{color:#6b7398;font-style:italic}
.tok-s{color:#9ece6a}
.tok-n{color:#ff9e64}
.tok-k{color:#7aa2f7;font-weight:600}
.md-body{line-height:1.65;word-wrap:break-word}
.md-body h1,.md-body h2,.md-body h3,.md-body h4{line-height:1.3;margin:1.1em 0 .5em}
.md-body h1{font-size:1.5rem;border-bottom:1px solid #2a3050;padding-bottom:.3em}
.md-body h2{font-size:1.25rem;border-bottom:1px solid #2a3050;padding-bottom:.25em}
.md-body p{margin:.7em 0}
.md-body ul,.md-body ol{margin:.7em 0;padding-left:1.6em}
.md-body li{margin:.25em 0}
.md-body code{background:#0d1226;border:1px solid #2a3050;border-radius:5px;padding:1px 5px;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
.md-body pre.code{margin:.8em 0}
.md-body blockquote{margin:.7em 0;padding:.2em 1em;border-left:3px solid #3b6ef6;color:#9aa3c7}
.md-body a{color:#8ab4ff}
.md-body hr{border:0;border-top:1px solid #2a3050;margin:1.2em 0}
.md-body img{max-width:100%}
.dxp-stage{position:relative;margin:14px 0;background:#0d1226;border:1px solid #2a3050;border-radius:12px;overflow:hidden}
.dxp-stage video{display:block;width:100%;max-height:70vh;background:#000}
.dxp-now{font-weight:600;margin:6px 0 10px;word-break:break-all}
.dxp-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.dxp-track{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid #2a3050;border-radius:9px;cursor:pointer;transition:border-color .15s,background .15s}
.dxp-track:hover{border-color:#3b6ef6}
.dxp-track.active{background:rgba(59,110,246,.14);border-color:#3b6ef6}
.dxp-ico{flex:none}
.dxp-name{word-break:break-all;font-size:.92rem}
.file-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dx-resume-panel{position:fixed;right:14px;bottom:14px;z-index:30;width:min(390px,calc(100vw - 28px));max-height:min(65vh,560px);overflow:auto;background:#151a2e;border:1px solid #33406b;border-radius:13px;box-shadow:0 18px 55px rgba(0,0,0,.5);padding:10px}
.dx-resume-panel[hidden]{display:none}.dx-resume-head{font-weight:700;padding:3px 4px 8px}.dx-resume-list{display:flex;flex-direction:column;gap:8px}
.dx-resume-row{display:grid;grid-template-columns:1fr auto;gap:5px 10px;padding:9px;border:1px solid #2a3050;border-radius:9px;background:#0f1220}.dx-resume-row strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dx-resume-meta{font-size:.78rem;color:#9aa3c7;grid-column:1/-1}.dx-resume-row progress{width:100%;height:7px;grid-column:1/-1;accent-color:#3b6ef6}.dx-resume-actions{display:flex;gap:6px;grid-column:1/-1}.dx-resume-actions .btn{margin:0;padding:6px 10px;font-size:.78rem;cursor:pointer}
.pw-hint{margin:0 0 12px;padding:8px 12px;border-radius:8px;background:rgba(250,204,21,.12);border:1px solid rgba(250,204,21,.3);color:#eab308;font-size:.92rem;word-break:break-word}
.pw-hint .ico{margin-right:6px}
.dl-eta{font-size:.86rem;margin:2px 0 6px}
.dl-expiry{font-size:.9rem;margin:2px 0 8px}
.dl-expiry .dl-expiry-val{font-variant-numeric:tabular-nums;font-weight:600}
.dl-expiry.is-expired{color:#f87171}
.btn-ghost{background:transparent;border:1px solid #2a3050;color:#bcd2ff}
.filelist td{vertical-align:middle}
.fl-name{word-break:break-all}
.fl-size{white-space:nowrap;color:#9aa3c7;text-align:right}
.fl-act{white-space:nowrap;text-align:right}
.row-act{display:inline-block;margin-left:10px;color:#8ab4ff;text-decoration:none;font-size:.9rem}
.row-act:hover{text-decoration:underline}
.fl-controls{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 2px}
.fl-acts{display:inline-flex;gap:14px;align-items:center;flex-wrap:wrap}
.sel-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 2px;padding:8px 12px;border:1px solid #2a3050;border-radius:10px;background:#141830;font-size:.9rem;color:#9aa3c7}
.sel-cb{margin-right:8px;vertical-align:middle;accent-color:#3b6ef6}
.file-sums{margin-top:12px;text-align:center}
.fl-search{width:100%;margin:8px 0 2px;padding:10px 12px;border-radius:10px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font:inherit;font-size:.92rem}
.fl-search:focus{outline:none;border-color:#3b6ef6}
.fl-noresult{margin:12px 0}
.view-toggle{display:inline-flex;border:1px solid #2a3050;border-radius:9px;overflow:hidden}
.vt-btn{background:transparent;border:0;color:#9aa3c7;padding:7px 13px;font-size:.85rem;cursor:pointer;font-family:inherit}
.vt-btn:hover{color:#e7e9f3}
.vt-btn.active{background:#3b6ef6;color:#fff}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin:14px 0 4px}
.g-tile{display:flex;flex-direction:column;text-decoration:none;color:#cdd8f5;border:1px solid #2a3050;border-radius:12px;overflow:hidden;background:#151a2e}
.g-tile:hover{border-color:#3b6ef6}
.g-media{position:relative;display:block;aspect-ratio:1/1;background:#0d1226}
.g-media img,.g-media video{width:100%;height:100%;object-fit:cover;display:block}
.g-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.7rem;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.6);pointer-events:none}
.g-cap{padding:7px 9px;font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.has-gallery[data-view="list"] .gallery{display:none}
.has-gallery[data-view="gallery"] .list-view{display:none}
td{word-break:break-word}
.btn.block{display:block;width:100%;text-align:center;margin-top:6px}
.inbox-head{display:flex;align-items:center;gap:14px;margin-bottom:4px}
.inbox-badge{flex:0 0 auto;width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:1.55rem;background:linear-gradient(180deg,#1f2a4d,#182238);border:1px solid #2a3050}
.inbox-head-txt h1{margin:0}
.inbox-head-txt .muted{margin:3px 0 0}
.up-drop{display:flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed #33406b;border-radius:16px;padding:32px 20px;text-align:center;margin:18px 0;cursor:pointer;transition:border-color .15s,background .15s}
.up-drop:hover{border-color:#3b6ef6;background:rgba(59,110,246,.05)}
.up-drop.drag{border-color:#3b6ef6;background:rgba(59,110,246,.1)}
.up-drop-ico{font-size:2rem;line-height:1;color:#8ab4ff}
.up-drop-title{font-weight:600;font-size:1rem}
.up-drop-sub{color:#9aa3c7;font-size:.82rem}
.btn.ghost{background:transparent;border:1px solid #2a3050;color:#bcd2ff;font-weight:600}
.btn.ghost:hover{border-color:#3b6ef6;background:rgba(59,110,246,.08)}
.btn.sm{padding:8px 14px;font-size:.85rem;margin-top:0}
.btn.xs{padding:5px 10px;font-size:.78rem;margin-top:0}
.btn.danger{background:transparent;border:1px solid #5a2a2a;color:#e79a9a;font-weight:600}
.btn.danger:hover{border-color:#e06c6c;background:rgba(224,108,108,.1)}
.up-modes{display:flex;gap:10px;justify-content:center;margin:2px 0 4px;flex-wrap:wrap}
.up-folder-current{text-align:center;margin:8px 0 0;font-size:.84rem;color:#8ab4ff;word-break:break-word}
.up-limits{text-align:center;margin:8px 0 0;font-size:.82rem}
.up-msg-label .req{color:#ef4444;font-weight:700}
.inbox-note{display:flex;gap:10px;align-items:flex-start;background:rgba(59,110,246,.08);border:1px solid #2a3050;border-left:3px solid #3b6ef6;border-radius:10px;padding:12px 14px;margin:14px 0 4px}
.inbox-note-ico{flex:0 0 auto;font-size:1.1rem;line-height:1.3}
.inbox-note-txt{font-size:.9rem;color:#cdd8f5;word-break:break-word}
.up-msg-label{display:block;font-size:.82rem;color:#9aa3c7;margin:6px 0 4px}
.up-msg{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font:inherit;font-size:.92rem;resize:vertical;margin-bottom:10px}
.up-msg:focus{outline:none;border-color:#3b6ef6}
.enc-banner{display:flex;gap:10px;align-items:center;background:rgba(56,211,155,.09);border:1px solid #2a3050;border-left:3px solid #38d39b;border-radius:10px;padding:11px 14px;margin:14px 0 8px;font-size:.9rem;color:#cdeee0}
.enc-ico{flex:0 0 auto}
.enc-bar-wrap{margin:12px 0}
.up-warn{background:rgba(255,192,97,.1);border:1px solid #4a3f22;border-left:3px solid #ffc061;border-radius:10px;padding:12px 14px;margin:14px 0;font-size:.88rem;line-height:1.4;color:#f2d9a8}
.uprow.skip{opacity:.7}
.upcancel{flex:0 0 auto;align-self:center;width:26px;height:26px;padding:0;border-radius:8px;border:1px solid #2a3050;background:transparent;color:#9aa3c7;font-size:.9rem;line-height:1;cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.upcancel:hover{color:#ff6b81;border-color:#ff6b81;background:rgba(255,107,129,.08)}
.up-list-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 0}
.up-list-count{font-size:.85rem}
.up-list{display:flex;flex-direction:column;gap:10px;margin:12px 0 16px}
.uprow{display:flex;align-items:flex-start;gap:12px;background:#151a2e;border:1px solid #2a3050;border-radius:12px;padding:12px 14px}
.upicon{flex:0 0 auto;font-size:1.3rem;line-height:1.25}
.upmain{flex:1;min-width:0}
.uptop{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.upname{font-weight:600;word-break:break-all;font-size:.92rem}
.upbar{height:7px;background:#2a3050;border-radius:5px;overflow:hidden;margin:8px 0 6px}
.upbar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3b6ef6,#5b8dff);border-radius:5px;transition:width .2s}
.upmeta{display:flex;gap:4px 14px;flex-wrap:wrap;font-size:.76rem;color:#6b7398;font-variant-numeric:tabular-nums}
.upmeta .upspeed{color:#8ab4ff}
.upstatus{flex:0 0 auto;color:#9aa3c7;font-size:.82rem;font-variant-numeric:tabular-nums}
.upmsg{width:100%;margin-top:8px;padding:7px 10px;border-radius:8px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font:inherit;font-size:.85rem}
.upmsg:focus{outline:none;border-color:#3b6ef6}
.upmsg:disabled{opacity:.6}
.upstatus.ok{color:#38d39b}
.upstatus.err{color:#ff6b81}
.err{color:#ff6b81;font-size:.9rem;margin:8px 0}
input.pw{width:100%;padding:12px 14px;margin:12px 0;border-radius:10px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font-size:1rem}
input.pw:focus{outline:none;border-color:#3b6ef6}
@media(max-width:600px){
.wrap{padding:22px 14px}
.card{padding:20px 16px}
.brandbar{padding:12px 14px}
th,td{padding:9px 6px;font-size:.86rem}
.btn{padding:12px 20px}
}
`;

// Language of public pages, by priority:
//   ?lang=xx (explicit choice) > "lang" cookie > Accept-Language > en.
function pickLang(req) {
  const supported = ['fr', 'en', 'es'];
  const q = String((req && req.query && req.query.lang) || '').toLowerCase();
  if (supported.includes(q)) return q;
  const cookies = parseCookies(req);
  const c = String(cookies.lang || '').toLowerCase();
  if (supported.includes(c)) return c;
  const al = String((req && req.headers && req.headers['accept-language']) || '').toLowerCase();
  for (const part of al.split(',')) {
    const code = part.trim().slice(0, 2);
    if (supported.includes(code)) return code;
  }
  // Admin-configured default public language (falls back to English).
  const def = String(getSettings().publicLang || '').toLowerCase();
  if (supported.includes(def)) return def;
  return 'en';
}

const PUB = {
  fr: {
    download: '⬇ Télécharger',
    expiresIn: '⏳ Expire dans', expired: '⏳ Expiré', etaLabel: '⏱️ Durée estimée', durUnits: 'j,h,min,s', pwHint: '💡 Indice',
    quotaReached: 'Vous avez atteint votre limite de téléchargements pour ce lien.',
    preview: '👁 Aperçu',
    vidUnsupported: 'Aperçu impossible dans ce navigateur pour ce format — le codec n’est pas pris en charge.',
    downloadAllZip: '⬇ Tout télécharger (.zip)',
    checksums: '🔐 Empreintes (.sha256)',
    selectZip: '⬇ Télécharger la sélection (.zip)',
    selectAll: 'Tout', selectNone: 'Aucun',
    selectedWord: 'sélectionné(s)',
    playerLabel: '▶ Lecteur',
    noMedia: 'Aucun fichier audio ou vidéo à lire dans ce dossier.',
    backToFiles: '← Retour aux fichiers',
    subsOff: 'Sous-titres désactivés',
    filesWord: 'fichiers',
    itemsWord: 'éléments',
    browseLabel: 'Parcourir',
    zipLabel: '⬇ .zip',
    viewList: '☰ Liste',
    viewGallery: '▦ Galerie',
    size: 'Taille',
    name: 'Nom',
    emptyFolder: 'Dossier vide',
    searchPh: '🔍 Filtrer par nom…',
    noResult: 'Aucun fichier ne correspond.',
    footer: `${APP_NAME} · © ${APP_YEAR} · v${APP_VERSION}`,
    shareGone: 'Ce partage n\'existe pas ou a été révoqué.',
    notYetActive: 'Ce lien n\'est pas encore disponible.',
    fileNotFound: 'Fichier introuvable.',
    readError: 'Erreur de lecture du fichier.',
    notFound: 'Introuvable.',
    fileUnavailable: 'Fichier indisponible.',
    hotlinkBlocked: 'Ce lien d\'image est protégé contre le hotlink.',
    albumTitle: 'Galerie d\'images',
    albumCount: '{n} images',
    albumEmpty: 'Aucune image dans cette galerie.',
    photoMetadataRemoved: 'EXIF/GPS supprimés',
    folderUnavailable: 'Dossier indisponible.',
    folderNotFound: 'Dossier introuvable.',
    zipError: 'Erreur de compression.',
    pageNotFound: 'Page introuvable.',
    tooManyReq: 'Trop de requêtes. Merci de patienter un instant avant de réessayer.',
    accessDenied: 'Accès refusé depuis votre emplacement ou votre réseau.',
    chalTitle: 'Vérification avant téléchargement',
    chalIntro: 'Pour protéger ce lien contre les abus, votre navigateur doit résoudre un petit défi. Cela se fait automatiquement, sans aucun tiers.',
    chalWorking: 'Calcul en cours…',
    chalVerify: 'Vérification…',
    chalFail: 'La vérification a échoué. Rechargez la page pour réessayer.',
    chalNoJs: 'JavaScript est requis pour vérifier ce téléchargement.',
    rawView: '📄 Version brute',
    zipEntries: 'entrées dans l\'archive',
    archiveEmpty: 'Archive vide.',
    archiveUnreadable: 'Impossible de lire le contenu de cette archive.',
    archiveTruncated: 'Liste tronquée (trop d\'entrées).',
    previewTruncated: 'Aperçu tronqué : fichier trop volumineux.',
    adminLanOnly: "L'interface d'administration n'est accessible que depuis le réseau local.",
    inboxIntro: 'Envoyez un ou plusieurs fichiers.',
    inboxHint: 'Cliquez ou glissez vos fichiers ici',
    inboxHint2: 'Sélection multiple acceptée',
    inboxSend: 'Envoyer',
    inboxRestrictions: 'Avant l’envoi', inboxRestrictionsHint: 'Vérifiez les limites de ce lien avant de choisir vos fichiers.', inboxDuplicatePolicy: 'Doublons : choix Remplacer / Conserver les deux / Ignorer avant l’envoi', inboxModeratedPolicy: 'Les fichiers attendent l’approbation du destinataire.', inboxSenderPolicy: 'Le nom de l’expéditeur est obligatoire.', inboxExecPolicy: 'Les exécutables détectés sont bloqués.',
    inboxPickFiles: '📄 Fichiers',
    inboxPickFolder: '📁 Dossier',
    newFolder: '📁 Nouveau dossier',
    newFolderPrompt: 'Nom du nouveau dossier :',
    folderCreated: 'Dossier créé',
    folderCreateFail: 'Impossible de créer le dossier.',
    folderInvalid: 'Ce nom de dossier est invalide.',
    folderExists: 'Un dossier ou un fichier porte déjà ce nom.',
    folderBusy: 'Attendez la fin de l’envoi avant de changer de dossier.',
    uploadDestination: 'Destination : {path}',
    msgLabel: 'Message (facultatif)',
    senderLabel: 'Votre nom',
    senderPh: 'Pour classer votre envoi (facultatif)',
    senderRequired: 'Veuillez indiquer votre nom avant l’envoi.',
    msgPh: 'Un mot pour accompagner votre envoi…',
    limitPerFile: 'Max {v} par fichier',
    limitQuota: 'Quota : {v} restants sur {t}',
    limitFiles: '{v} fichiers restants sur {t}',
    limitFilesPerUpload: 'Max {v} fichiers par envoi',
    limitAllow: 'Types autorisés : {v}',
    visitorSlots: '👤 {v} place(s) restante(s) sur {t}',
    zipEstTitle: 'Taille totale estimée (somme des fichiers connus)',
    limitBlock: 'Types bloqués : {v}',
    langPending: "Sera appliqué à la fin de l'envoi en cours.",
    themeLabel: 'Thème', themeDark: 'Sombre', themeLight: 'Clair', themeAuto: 'Auto',
    pwPrompt: 'Ce lien est protégé. Saisissez le mot de passe pour continuer.',
    pwField: 'Mot de passe',
    pwSubmit: 'Déverrouiller',
    pwWrong: 'Mot de passe incorrect.',
    reqPrompt: "Ce lien est privé. Demandez l'accès ci-dessous ; un administrateur validera votre demande.",
    reqName: 'Votre nom',
    reqEmail: 'E-mail (pour être prévenu, facultatif)',
    reqMessage: 'Message (facultatif)',
    reqSubmit: "Demander l'accès",
    reqPending: "Votre demande a été envoyée et attend l'approbation d'un administrateur.",
    reqPendingHint: 'Cette page se rafraîchit automatiquement — vous pouvez la laisser ouverte.',
    reqDenied: "Votre demande d'accès a été refusée.",
    fbTitle: 'Laisser un commentaire',
    fbName: 'Votre nom (facultatif)',
    fbBody: 'Votre commentaire',
    fbSubmit: 'Envoyer',
    fbThanks: 'Merci, votre commentaire a bien été transmis.',
    fbError: "Envoi impossible pour l'instant. Réessayez.",
    encInboxBanner: 'Ce dépôt est chiffré de bout en bout dans votre navigateur.',
    encPassLabel: 'Phrase secrète de chiffrement',
    encPassPh: 'Phrase communiquée par le destinataire',
    encEncrypting: 'chiffrement…',
    encPassRequired: 'Saisissez d’abord la phrase secrète de chiffrement.',
    encKeyMissing: 'Ce lien est incomplet (clé manquante).',
    encDlTitle: 'Fichier chiffré',
    encDlIntro: 'Ce fichier est chiffré de bout en bout. Il sera déchiffré dans votre navigateur.',
    encDlPassLabel: 'Phrase secrète',
    encDlBtn: '🔓 Déchiffrer et télécharger',
    encDlWorking: 'Déchiffrement…',
    encDlDownloading: 'Téléchargement du fichier chiffré…',
    encDlBadKey: 'Clé ou phrase secrète incorrecte, ou fichier altéré.',
    encDlKeyMissing: 'Ce lien est incomplet (clé de déchiffrement manquante).',
    encDlReady: 'Terminé — le téléchargement devrait démarrer.',
    collabIntro: 'Dossier partagé : téléchargez et déposez des fichiers.',
    collabDelete: '🗑 Supprimer',
    collabDeleteConfirm: 'Supprimer « {n} » ? Cette action est irréversible.',
    collabDeleted: 'Supprimé',
    collabDeleteFail: 'Échec de la suppression',
    collabUploaded: 'Envoyé',
    collabUploadFail: 'Échec de l’envoi',
    collabParent: '⬆ Dossier parent',
    collabRefresh: '↻ Actualiser',
    collabHome: 'Racine',
    secretTitle: 'Note secrète',
    secretIntro: 'Ce message est chiffré de bout en bout et sera détruit dès sa première lecture.',
    secretReveal: '🔓 Révéler le secret',
    secretPassLabel: 'Phrase secrète',
    secretPassPh: 'Communiquée séparément',
    secretWorking: 'Déchiffrement…',
    secretBadKey: 'Clé ou phrase secrète incorrecte.',
    secretKeyMissing: 'Ce lien est incomplet (clé manquante).',
    secretGone: 'Ce secret a déjà été lu ou a expiré — il n’existe plus.',
    secretOneShot: '⚠ Ce secret ne peut être lu qu’une seule fois : une mauvaise clé ne pourra pas être réessayée.',
    secretCopy: '📋 Copier',
    copied: 'Copié !',
  },
  en: {
    download: '⬇ Download',
    expiresIn: '⏳ Expires in', expired: '⏳ Expired', etaLabel: '⏱️ Est. time', durUnits: 'd,h,m,s', pwHint: '💡 Hint',
    quotaReached: 'You have reached your download limit for this link.',
    preview: '👁 Preview',
    vidUnsupported: 'This format can’t be previewed in your browser — the codec isn’t supported.',
    downloadAllZip: '⬇ Download all (.zip)',
    checksums: '🔐 Checksums (.sha256)',
    selectZip: '⬇ Download selection (.zip)',
    selectAll: 'All', selectNone: 'None',
    selectedWord: 'selected',
    playerLabel: '▶ Player',
    noMedia: 'No audio or video files to play in this folder.',
    backToFiles: '← Back to files',
    subsOff: 'Subtitles off',
    filesWord: 'files',
    itemsWord: 'items',
    browseLabel: 'Browse',
    zipLabel: '⬇ .zip',
    viewList: '☰ List',
    viewGallery: '▦ Gallery',
    size: 'Size',
    name: 'Name',
    emptyFolder: 'Empty folder',
    searchPh: '🔍 Filter by name…',
    noResult: 'No file matches.',
    footer: `${APP_NAME} · © ${APP_YEAR} · v${APP_VERSION}`,
    shareGone: 'This share does not exist or has been revoked.',
    notYetActive: 'This link is not available yet.',
    fileNotFound: 'File not found.',
    readError: 'File read error.',
    notFound: 'Not found.',
    fileUnavailable: 'File unavailable.',
    hotlinkBlocked: 'This image link is hotlink-protected.',
    albumTitle: 'Image gallery',
    albumCount: '{n} images',
    albumEmpty: 'No images in this gallery.',
    photoMetadataRemoved: 'EXIF/GPS removed',
    folderUnavailable: 'Folder unavailable.',
    folderNotFound: 'Folder not found.',
    zipError: 'Compression error.',
    pageNotFound: 'Page not found.',
    tooManyReq: 'Too many requests. Please wait a moment before trying again.',
    accessDenied: 'Access denied from your location or network.',
    chalTitle: 'Verification before download',
    chalIntro: 'To protect this link from abuse, your browser must solve a small challenge. It runs automatically, with no third party involved.',
    chalWorking: 'Working…',
    chalVerify: 'Verifying…',
    chalFail: 'Verification failed. Reload the page to try again.',
    chalNoJs: 'JavaScript is required to verify this download.',
    rawView: '📄 Raw version',
    zipEntries: 'entries in the archive',
    archiveEmpty: 'Empty archive.',
    archiveUnreadable: 'Could not read this archive\'s contents.',
    archiveTruncated: 'Listing truncated (too many entries).',
    previewTruncated: 'Preview truncated: file too large.',
    adminLanOnly: 'The admin interface is only reachable from the local network.',
    inboxIntro: 'Send one or more files.',
    inboxHint: 'Click or drop your files here',
    inboxHint2: 'Multiple files supported',
    inboxSend: 'Send',
    inboxRestrictions: 'Before uploading', inboxRestrictionsHint: 'Check this link’s limits before choosing files.', inboxDuplicatePolicy: 'Duplicates: choose Replace / Keep both / Ignore before upload', inboxModeratedPolicy: 'Files wait for recipient approval.', inboxSenderPolicy: 'Sender name is required.', inboxExecPolicy: 'Detected executable files are blocked.',
    inboxPickFiles: '📄 Files',
    inboxPickFolder: '📁 Folder',
    newFolder: '📁 New folder',
    newFolderPrompt: 'New folder name:',
    folderCreated: 'Folder created',
    folderCreateFail: 'Could not create the folder.',
    folderInvalid: 'This folder name is invalid.',
    folderExists: 'A folder or file already uses this name.',
    folderBusy: 'Wait for the upload to finish before changing folders.',
    uploadDestination: 'Destination: {path}',
    msgLabel: 'Message (optional)',
    senderLabel: 'Your name',
    senderPh: 'To file your deposit (optional)',
    senderRequired: 'Please enter your name before sending.',
    msgPh: 'A note to go with your upload…',
    limitPerFile: 'Max {v} per file',
    limitQuota: 'Quota: {v} left of {t}',
    limitFiles: '{v} files left of {t}',
    limitFilesPerUpload: 'Max {v} files per upload',
    limitAllow: 'Allowed types: {v}',
    visitorSlots: '👤 {v} slot(s) left of {t}',
    zipEstTitle: 'Estimated total size (sum of known files)',
    limitBlock: 'Blocked types: {v}',
    langPending: 'Will apply once the current transfer finishes.',
    themeLabel: 'Theme', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'Auto',
    pwPrompt: 'This link is protected. Enter the password to continue.',
    pwField: 'Password',
    pwSubmit: 'Unlock',
    pwWrong: 'Incorrect password.',
    reqPrompt: 'This link is private. Request access below; an administrator will review your request.',
    reqName: 'Your name',
    reqEmail: 'Email (to be notified, optional)',
    reqMessage: 'Message (optional)',
    reqSubmit: 'Request access',
    reqPending: 'Your request has been sent and is awaiting an administrator’s approval.',
    reqPendingHint: 'This page refreshes automatically — you can leave it open.',
    reqDenied: 'Your access request was declined.',
    fbTitle: 'Leave a comment',
    fbName: 'Your name (optional)',
    fbBody: 'Your comment',
    fbSubmit: 'Send',
    fbThanks: 'Thanks — your comment has been sent.',
    fbError: 'Could not send right now. Please retry.',
    encInboxBanner: 'This deposit is end-to-end encrypted in your browser.',
    encPassLabel: 'Encryption passphrase',
    encPassPh: 'Passphrase provided by the recipient',
    encEncrypting: 'encrypting…',
    encPassRequired: 'Enter the encryption passphrase first.',
    encKeyMissing: 'This link is incomplete (missing key).',
    encDlTitle: 'Encrypted file',
    encDlIntro: 'This file is end-to-end encrypted. It will be decrypted in your browser.',
    encDlPassLabel: 'Passphrase',
    encDlBtn: '🔓 Decrypt & download',
    encDlWorking: 'Decrypting…',
    encDlDownloading: 'Downloading ciphertext…',
    encDlBadKey: 'Wrong key or passphrase, or corrupted file.',
    encDlKeyMissing: 'This link is incomplete (missing decryption key).',
    encDlReady: 'Done — your download should start.',
    collabIntro: 'Shared folder: download and drop files.',
    collabDelete: '🗑 Delete',
    collabDeleteConfirm: 'Delete “{n}”? This cannot be undone.',
    collabDeleted: 'Deleted',
    collabDeleteFail: 'Delete failed',
    collabUploaded: 'Uploaded',
    collabUploadFail: 'Upload failed',
    collabParent: '⬆ Parent folder',
    collabRefresh: '↻ Refresh',
    collabHome: 'Home',
    secretTitle: 'Secret note',
    secretIntro: 'This message is end-to-end encrypted and will be destroyed as soon as it is read once.',
    secretReveal: '🔓 Reveal the secret',
    secretPassLabel: 'Passphrase',
    secretPassPh: 'Shared separately',
    secretWorking: 'Decrypting…',
    secretBadKey: 'Wrong key or passphrase.',
    secretKeyMissing: 'This link is incomplete (missing key).',
    secretGone: 'This secret has already been read or has expired — it no longer exists.',
    secretOneShot: '⚠ This secret can only be viewed once: a wrong key cannot be retried.',
    secretCopy: '📋 Copy',
    copied: 'Copied!',
  },
  es: {
    download: '⬇ Descargar',
    expiresIn: '⏳ Caduca en', expired: '⏳ Caducado', etaLabel: '⏱️ Tiempo est.', durUnits: 'd,h,m,s', pwHint: '💡 Pista',
    quotaReached: 'Has alcanzado tu límite de descargas para este enlace.',
    preview: '👁 Vista previa',
    vidUnsupported: 'Este formato no se puede previsualizar en tu navegador — el códec no es compatible.',
    downloadAllZip: '⬇ Descargar todo (.zip)',
    checksums: '🔐 Sumas (.sha256)',
    selectZip: '⬇ Descargar selección (.zip)',
    selectAll: 'Todo', selectNone: 'Ninguno',
    selectedWord: 'seleccionado(s)',
    playerLabel: '▶ Reproductor',
    noMedia: 'No hay archivos de audio o vídeo para reproducir en esta carpeta.',
    backToFiles: '← Volver a los archivos',
    subsOff: 'Subtítulos desactivados',
    filesWord: 'archivos',
    itemsWord: 'elementos',
    browseLabel: 'Explorar',
    zipLabel: '⬇ .zip',
    viewList: '☰ Lista',
    viewGallery: '▦ Galería',
    size: 'Tamaño',
    name: 'Nombre',
    emptyFolder: 'Carpeta vacía',
    searchPh: '🔍 Filtrar por nombre…',
    noResult: 'Ningún archivo coincide.',
    footer: `${APP_NAME} · © ${APP_YEAR} · v${APP_VERSION}`,
    shareGone: 'Esta compartición no existe o ha sido revocada.',
    notYetActive: 'Este enlace aún no está disponible.',
    fileNotFound: 'Archivo no encontrado.',
    readError: 'Error al leer el archivo.',
    notFound: 'No encontrado.',
    fileUnavailable: 'Archivo no disponible.',
    hotlinkBlocked: 'Este enlace de imagen está protegido contra el hotlinking.',
    albumTitle: 'Galería de imágenes',
    albumCount: '{n} imágenes',
    albumEmpty: 'No hay imágenes en esta galería.',
    photoMetadataRemoved: 'EXIF/GPS eliminados',
    folderUnavailable: 'Carpeta no disponible.',
    folderNotFound: 'Carpeta no encontrada.',
    zipError: 'Error de compresión.',
    pageNotFound: 'Página no encontrada.',
    tooManyReq: 'Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.',
    accessDenied: 'Acceso denegado desde tu ubicación o red.',
    chalTitle: 'Verificación antes de descargar',
    chalIntro: 'Para proteger este enlace del abuso, tu navegador debe resolver un pequeño desafío. Se ejecuta automáticamente, sin ningún tercero.',
    chalWorking: 'Calculando…',
    chalVerify: 'Verificando…',
    chalFail: 'La verificación falló. Recarga la página para volver a intentarlo.',
    chalNoJs: 'Se requiere JavaScript para verificar esta descarga.',
    rawView: '📄 Versión sin procesar',
    zipEntries: 'entradas en el archivo',
    archiveEmpty: 'Archivo vacío.',
    archiveUnreadable: 'No se pudo leer el contenido de este archivo.',
    archiveTruncated: 'Lista truncada (demasiadas entradas).',
    previewTruncated: 'Vista previa truncada: archivo demasiado grande.',
    adminLanOnly: 'La interfaz de administración solo es accesible desde la red local.',
    inboxIntro: 'Envía uno o varios archivos.',
    inboxHint: 'Haz clic o arrastra tus archivos aquí',
    inboxHint2: 'Selección múltiple admitida',
    inboxSend: 'Enviar',
    inboxRestrictions: 'Antes de subir', inboxRestrictionsHint: 'Revisa los límites de este enlace antes de elegir archivos.', inboxDuplicatePolicy: 'Duplicados: elige Reemplazar / Conservar ambos / Ignorar antes de subir', inboxModeratedPolicy: 'Los archivos esperan la aprobación del destinatario.', inboxSenderPolicy: 'El nombre del remitente es obligatorio.', inboxExecPolicy: 'Los ejecutables detectados se bloquean.',
    inboxPickFiles: '📄 Archivos',
    inboxPickFolder: '📁 Carpeta',
    newFolder: '📁 Nueva carpeta',
    newFolderPrompt: 'Nombre de la nueva carpeta:',
    folderCreated: 'Carpeta creada',
    folderCreateFail: 'No se pudo crear la carpeta.',
    folderInvalid: 'Este nombre de carpeta no es válido.',
    folderExists: 'Ya existe una carpeta o un archivo con este nombre.',
    folderBusy: 'Espera a que termine el envío antes de cambiar de carpeta.',
    uploadDestination: 'Destino: {path}',
    msgLabel: 'Mensaje (opcional)',
    senderLabel: 'Tu nombre',
    senderPh: 'Para archivar tu envío (opcional)',
    senderRequired: 'Introduce tu nombre antes de enviar.',
    msgPh: 'Unas palabras para acompañar tu envío…',
    limitPerFile: 'Máx. {v} por archivo',
    limitQuota: 'Cuota: {v} de {t} disponibles',
    limitFiles: '{v} de {t} archivos disponibles',
    limitFilesPerUpload: 'Máx. {v} archivos por envío',
    limitAllow: 'Tipos permitidos: {v}',
    visitorSlots: '👤 {v} plaza(s) restante(s) de {t}',
    zipEstTitle: 'Tamaño total estimado (suma de archivos conocidos)',
    limitBlock: 'Tipos bloqueados: {v}',
    langPending: 'Se aplicará al finalizar el envío en curso.',
    themeLabel: 'Tema', themeDark: 'Oscuro', themeLight: 'Claro', themeAuto: 'Auto',
    pwPrompt: 'Este enlace está protegido. Introduce la contraseña para continuar.',
    pwField: 'Contraseña',
    pwSubmit: 'Desbloquear',
    pwWrong: 'Contraseña incorrecta.',
    reqPrompt: 'Este enlace es privado. Solicita acceso abajo; un administrador revisará tu solicitud.',
    reqName: 'Tu nombre',
    reqEmail: 'Correo (para avisarte, opcional)',
    reqMessage: 'Mensaje (opcional)',
    reqSubmit: 'Solicitar acceso',
    reqPending: 'Tu solicitud se ha enviado y espera la aprobación de un administrador.',
    reqPendingHint: 'Esta página se actualiza automáticamente — puedes dejarla abierta.',
    reqDenied: 'Tu solicitud de acceso ha sido rechazada.',
    fbTitle: 'Dejar un comentario',
    fbName: 'Tu nombre (opcional)',
    fbBody: 'Tu comentario',
    fbSubmit: 'Enviar',
    fbThanks: 'Gracias, tu comentario se ha enviado.',
    fbError: 'No se pudo enviar ahora. Inténtalo de nuevo.',
    encInboxBanner: 'Este depósito se cifra de extremo a extremo en tu navegador.',
    encPassLabel: 'Frase de cifrado',
    encPassPh: 'Frase facilitada por el destinatario',
    encEncrypting: 'cifrando…',
    encPassRequired: 'Introduce primero la frase de cifrado.',
    encKeyMissing: 'Este enlace está incompleto (falta la clave).',
    encDlTitle: 'Archivo cifrado',
    encDlIntro: 'Este archivo está cifrado de extremo a extremo. Se descifrará en tu navegador.',
    encDlPassLabel: 'Frase secreta',
    encDlBtn: '🔓 Descifrar y descargar',
    encDlWorking: 'Descifrando…',
    encDlDownloading: 'Descargando el archivo cifrado…',
    encDlBadKey: 'Clave o frase incorrecta, o archivo alterado.',
    encDlKeyMissing: 'Este enlace está incompleto (falta la clave de descifrado).',
    encDlReady: 'Listo — la descarga debería comenzar.',
    collabIntro: 'Carpeta compartida: descarga y deposita archivos.',
    collabDelete: '🗑 Eliminar',
    collabDeleteConfirm: '¿Eliminar «{n}»? Esta acción no se puede deshacer.',
    collabDeleted: 'Eliminado',
    collabDeleteFail: 'Error al eliminar',
    collabUploaded: 'Enviado',
    collabUploadFail: 'Error al enviar',
    collabParent: '⬆ Carpeta superior',
    collabRefresh: '↻ Actualizar',
    collabHome: 'Inicio',
    secretTitle: 'Nota secreta',
    secretIntro: 'Este mensaje está cifrado de extremo a extremo y se destruirá en cuanto se lea una vez.',
    secretReveal: '🔓 Revelar el secreto',
    secretPassLabel: 'Frase de contraseña',
    secretPassPh: 'Comunicada por separado',
    secretWorking: 'Descifrando…',
    secretBadKey: 'Clave o frase de contraseña incorrecta.',
    secretKeyMissing: 'Este enlace está incompleto (falta la clave).',
    secretGone: 'Este secreto ya se ha leído o ha caducado — ya no existe.',
    secretOneShot: '⚠ Este secreto solo puede verse una vez: una clave incorrecta no podrá reintentarse.',
    secretCopy: '📋 Copiar',
    copied: '¡Copiado!',
  },
};

// Display name for the app: the admin-configured brand, or the built-in name.
function brandName() {
  const b = getSettings().brandName;
  return (typeof b === 'string' && b.trim()) ? b.trim() : APP_NAME;
}
// Optional accent-color override, injected as a CSS variable on public pages.
function accentStyleVar() {
  const c = getSettings().accentColor;
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) ? c.trim() : '';
}
// Custom logo (data: URL) for the public brand bar, falling back to
// the built-in mark. Validated the same way as on save.
function publicLogoSrc() {
  const v = getSettings().publicLogo;
  return (typeof v === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v.trim()))
    ? v.trim() : '/logo.svg';
}
// Confidentiality/legal banner shown on every public page.
function legalNoticeHtml() {
  const v = getSettings().legalNotice;
  if (typeof v !== 'string' || !v.trim()) return '';
  return `<div class="legal-banner"><span class="legal-ico" aria-hidden="true">⚠️</span><span>${esc(v.trim())}</span></div>`;
}
// Global announcement banner shown on every public page.
function announcementHtml() {
  const v = getSettings().announcement;
  if (typeof v !== 'string' || !v.trim()) return '';
  return `<div class="dx-announce" role="status"><span class="dx-announce-ico" aria-hidden="true">📢</span><span>${esc(v.trim())}</span></div>`;
}
// Text to overlay on image/video previews (visitor IP, or the
// recipient's name for a nominative sub-link). '' when watermarking is off.
function previewWatermark(req, tk) {
  if (!getSettings().watermarkPreviews) return '';
  const rc = tk ? recipientByToken.get(tk) : null;
  if (rc && rc.recipient && rc.recipient.name) return String(rc.recipient.name).slice(0, 60);
  return String(pubIp(clientIp(req)) || '').slice(0, 60);
}
// A tiled, semi-transparent SVG (data: URI) repeating the watermark text
// diagonally — used as a CSS background over previews.
function watermarkOverlay(text) {
  if (!text) return '';
  const t = esc(String(text)).slice(0, 120);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="170">`
    + `<text x="50%" y="50%" fill="rgba(255,255,255,0.30)" font-family="sans-serif" font-size="17" `
    + `font-weight="700" text-anchor="middle" dominant-baseline="middle" transform="rotate(-30 150 85)">${t}</text></svg>`;
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  return `<span class="wm-overlay" aria-hidden="true" style="background-image:url('${uri}')"></span>`;
}

// Public-page theme. The stylesheet's neutral palette is remapped to
// CSS variables so a light set can override it; 'auto' follows the device via
// prefers-color-scheme, 'dark'/'light' force one. Accent + semantic colors are
// untouched (they read on both). Built once per request (cheap string work).
const THEME_NEUTRALS = {
  '#0f1220': '--p-bg', '#e7e9f3': '--p-text', '#1a1e33': '--p-card', '#2a3050': '--p-border',
  '#9aa3c7': '--p-muted', '#8ab4ff': '--p-link', '#0d1226': '--p-inset', '#151a2e': '--p-row',
  '#6b7398': '--p-faint', '#c8d0f0': '--p-codetext', '#e8ebfb': '--p-strong',
  '#222846': '--p-border2', '#12172a': '--p-row2',
};
const THEME_DARK = ':root{--p-bg:#0f1220;--p-text:#e7e9f3;--p-card:#1a1e33;--p-border:#2a3050;'
  + '--p-muted:#9aa3c7;--p-link:#8ab4ff;--p-inset:#0d1226;--p-row:#151a2e;--p-faint:#6b7398;'
  + '--p-codetext:#c8d0f0;--p-strong:#e8ebfb;--p-border2:#222846;--p-row2:#12172a}';
const THEME_LIGHT = ':root{--p-bg:#f4f6fb;--p-text:#1a1e2e;--p-card:#ffffff;--p-border:#dde1ec;'
  + '--p-muted:#5a6280;--p-link:#2f5de0;--p-inset:#eef1f8;--p-row:#f7f8fc;--p-faint:#7b83a0;'
  + '--p-codetext:#2a2f45;--p-strong:#1a1e2e;--p-border2:#e6e9f2;--p-row2:#f0f2f8}';
// Default theme when the visitor has made no explicit choice. Dark is the default;
// admins can still pin 'light' or make it follow the device ('auto') as the default.
function publicThemeMode() {
  const v = getSettings().publicTheme;
  return ['auto', 'dark', 'light'].includes(v) ? v : 'dark';
}
function publicStyleBlock() {
  let css = PAGE_STYLE.replace(':root{color-scheme:light dark}', '');
  for (const hex of Object.keys(THEME_NEUTRALS)) css = css.split(hex).join(`var(${THEME_NEUTRALS[hex]})`);
  const ac = accentStyleVar();
  if (ac) css = css.replace(/#3b6ef6/g, 'var(--ac)');
  const acDecl = ac ? `:root{--ac:${ac}}` : '';
  // Both palettes are always shipped so a visitor can switch client-side (the
  // choice lands on <html data-theme="…">, applied before first paint). Dark is
  // the base; data-theme="light" forces light; "auto" follows the device.
  const lightInner = THEME_LIGHT.replace(':root{', '').replace(/}$/, '');
  const theme =
    ':root{color-scheme:dark}' + THEME_DARK
    + ':root[data-theme="light"]{color-scheme:light;' + lightInner + '}'
    + ':root[data-theme="auto"]{color-scheme:light dark}'
    + '@media (prefers-color-scheme:light){:root[data-theme="auto"]{' + lightInner + '}}';
  return theme + acDecl + css;
}
// Mobile browser UI color: an explicit themeColor, else the accent,
// else the page background (per current theme).
function themeColorValue() {
  const t = String(getSettings().themeColor || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
  const ac = accentStyleVar();
  if (ac) return ac;
  return publicThemeMode() === 'light' ? '#f4f6fb' : '#0f1220';
}

function pageShell(lang, title, bodyHtml) {
  const L = PUB[lang] || PUB.en;
  const ctx = requestContext.getStore();
  const nonceAttr = ctx && ctx.cspNonce ? ` nonce="${esc(ctx.cspNonce)}"` : '';
  // Every public page fragment is generated by this server. Attach the response
  // nonce to both inline configuration blocks and external scripts so the CSP
  // remains strict without breaking encrypted shares, secrets or collaboration.
  const nonceBody = nonceAttr
    ? String(bodyHtml || '')
        .replace(/<script(?![^>]*\bnonce\s*=)(?=[\s>])/g, `<script${nonceAttr}`)
        .replace(/<style(?![^>]*\bnonce\s*=)(?=[\s>])/g, `<style${nonceAttr}`)
    : String(bodyHtml || '');
  const langLink = (code, label) =>
    code === lang
      ? `<span class="active">${label}</span>`
      : `<a href="?lang=${code}" data-lang="${code}" rel="nofollow">${label}</a>`;
  const langsel = `<span class="langsel" data-lang-pending-msg="${esc(
    L.langPending
  )}"><span class="langsel-ico" aria-hidden="true">🌐</span>${langLink('fr', 'FR')}${langLink('en', 'EN')}${langLink('es', 'ES')}</span>`;
  const themesel = `<select class="themesel" aria-label="${esc(L.themeLabel)}" title="${esc(L.themeLabel)}">`
    + `<option value="dark">${esc(L.themeDark)}</option>`
    + `<option value="light">${esc(L.themeLight)}</option>`
    + `<option value="auto">${esc(L.themeAuto)}</option>`
    + `</select>`;
  return `<!doctype html><html lang="${esc(lang)}" data-dx-default-theme="${esc(publicThemeMode())}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<script${nonceAttr}>(function(){var d=document.documentElement.getAttribute('data-dx-default-theme')||'dark';var t;try{t=localStorage.getItem('dx-theme');}catch(e){}if(t!=='light'&&t!=='dark'&&t!=='auto')t=d;document.documentElement.setAttribute('data-theme',t);})();</script>
<meta name="theme-color" content="${esc(themeColorValue())}">
<link rel="icon" href="${esc(publicLogoSrc())}">
<title>${esc(title)}</title>
<style${nonceAttr}>${publicStyleBlock()}</style>
</head><body>
<header class="brandbar"><span class="bb-name"><img class="bb-logo" src="${esc(publicLogoSrc())}" alt="">${esc(brandName())}</span><span class="brandbar-tools">${langsel}${themesel}</span></header>
${announcementHtml()}${legalNoticeHtml()}
<div class="wrap">${nonceBody}</div>
<footer>${esc(L.footer)}</footer>
<script${nonceAttr}>
// Language switch: if an upload is in progress (reception page, see reception.js),
// we don't navigate immediately — that would cut the ongoing transfer. We store
// the choice (cookie) and target URL, and reception.js triggers navigation once
// the upload finishes. With no active transfer (normal page), the link navigates right away,
// as before.
(function () {
  var sel = document.querySelector('.langsel');
  var msg = sel ? sel.getAttribute('data-lang-pending-msg') : '';
  var links = document.querySelectorAll('.langsel a[data-lang]');
  Array.prototype.forEach.call(links, function (a) {
    a.addEventListener('click', function (e) {
      if (!window.__dxTransferActive) return;
      e.preventDefault();
      document.cookie = 'lang=' + this.getAttribute('data-lang') + '; Path=/; Max-Age=31536000; SameSite=Lax';
      window.__dxPendingLangUrl = this.getAttribute('href');
      Array.prototype.forEach.call(links, function (b) {
        b.classList.remove('pending');
        b.removeAttribute('title');
      });
      this.classList.add('pending');
      if (msg) this.setAttribute('title', msg);
    });
  });
})();
// Theme switch (client-side, persisted). Dark is the default; the choice is
// applied to <html data-theme> and stored under 'dx-theme'.
(function () {
  var sel = document.querySelector('.themesel');
  if (!sel) return;
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  sel.value = cur;
  sel.addEventListener('change', function () {
    var v = this.value;
    if (v !== 'light' && v !== 'auto') v = 'dark';
    try { localStorage.setItem('dx-theme', v); } catch (e) {}
    document.documentElement.setAttribute('data-theme', v);
  });
})();
// Live expiry countdown. No-op on pages without a .dl-expiry element.
(function () {
  var els = [].slice.call(document.querySelectorAll('.dl-expiry[data-dx-expires]'));
  if (!els.length) return;
  function fmt(secs, u) {
    secs = Math.max(0, Math.round(secs));
    var seg = [[Math.floor(secs/86400), u[0]], [Math.floor(secs%86400/3600), u[1]], [Math.floor(secs%3600/60), u[2]], [secs%60, u[3]]], out = [];
    for (var i = 0; i < seg.length; i++) { if (seg[i][0] > 0 || out.length) { out.push(seg[i][0] + seg[i][1]); if (out.length === 3) break; } }
    return out.length ? out.join(' ') : ('0' + u[3]);
  }
  function tick() {
    var now = Date.now();
    els.forEach(function (el) {
      var at = +el.getAttribute('data-dx-expires'), u = (el.getAttribute('data-dx-units') || 'd,h,m,s').split(',');
      var val = el.querySelector('.dl-expiry-val'), rem = (at - now) / 1000;
      if (rem <= 0) { el.textContent = el.getAttribute('data-dx-gone') || ''; el.classList.add('is-expired'); return; }
      if (val) val.textContent = fmt(rem, u);
    });
  }
  tick(); setInterval(tick, 1000);
})();
</script>
<script${nonceAttr} src="/download-resume.js" defer></script>
<script${nonceAttr} src="/media-resume.js" defer></script>
</body></html>`;
}

// --- Thumbnail gallery, shared by folder and collection pages ---
// media: [{ href, src, name, kind }] with kind 'image' | 'video'.
// Sources are deferred via data-src: with a lot of files, eagerly setting
// src="…" on every <video preload="metadata"> (or every <img>) fires that many
// requests the instant the page loads — even for tiles hidden behind the List
// view — which is what made large shares feel unresponsive. GALLERY_SCRIPT
// below fills in the real src only as tiles actually scroll into view.
function galleryHtml(media, wm) {
  const wmHtml = watermarkOverlay(wm);
  const tiles = media
    .map((m) => {
      const inner = m.kind === 'video'
        ? `<span class="g-media"><video data-src="${esc(m.src)}" preload="none" muted playsinline></video><span class="g-play">▶</span>${wmHtml}</span>`
        : `<span class="g-media"><img data-src="${esc(m.src)}" alt="">${wmHtml}</span>`;
      return `<a class="g-tile" data-name="${esc(String(m.name).toLowerCase())}" href="${esc(m.href)}" target="_blank" rel="noopener" title="${esc(m.name)}">${inner}<span class="g-cap">${esc(m.name)}</span></a>`;
    })
    .join('');
  return `<div class="gallery">${tiles}</div>`;
}

// Search box + client-side filter (hides list rows and gallery tiles by name).
// Shared by folderPage and collectionPage. The card gets the class `has-search`.
function searchBox(L) {
  return `<input type="search" class="fl-search" autocomplete="off" spellcheck="false" placeholder="${esc(L.searchPh)}" aria-label="${esc(L.searchPh)}">`;
}
const SEARCH_SCRIPT = `<script>(function(){
  var card=document.querySelector('.has-search'); if(!card) return;
  var input=card.querySelector('.fl-search'); if(!input) return;
  var rows=card.querySelectorAll('[data-name]');
  var none=card.querySelector('.fl-noresult');
  function apply(){
    var q=input.value.trim().toLowerCase(), shown=0;
    Array.prototype.forEach.call(rows,function(el){
      var hit = !q || el.getAttribute('data-name').indexOf(q)!==-1;
      el.style.display = hit ? '' : 'none';
      if(hit) shown++;
    });
    if(none) none.style.display = (q && shown===0) ? '' : 'none';
  }
  input.addEventListener('input', apply);
})();</script>`;
// Selective multi-file download. Adds a checkbox to each row and a
// "download selection (.zip)" toolbar that POSTs the picked items to the
// share's zip-select endpoint (a hidden form → a normal browser download).
const SELECT_SCRIPT = `<script>(function(){
  var card=document.querySelector('.has-select'); if(!card) return;
  var action=card.getAttribute('data-zipsel'); if(!action) return;
  var rows=card.querySelectorAll('[data-rel],[data-idx]');
  var bar=card.querySelector('.sel-bar'); var btn=card.querySelector('.sel-zip'); var count=card.querySelector('.sel-count'); var allBtn=card.querySelector('.sel-all'); var noneBtn=card.querySelector('.sel-none');
  if(!bar||!btn) return;
  Array.prototype.forEach.call(rows,function(tr){
    var td=tr.querySelector('td'); if(!td) return;
    var cb=document.createElement('input'); cb.type='checkbox'; cb.className='sel-cb'; cb.setAttribute('aria-label','select');
    td.insertBefore(cb, td.firstChild);
    cb.addEventListener('change', update);
  });
  function picked(){ return Array.prototype.filter.call(card.querySelectorAll('.sel-cb'),function(c){return c.checked;}); }
  function update(){ var n=picked().length; if(count)count.textContent=n; bar.style.display=n?'':'none'; }
  if(allBtn) allBtn.addEventListener('click',function(){Array.prototype.forEach.call(card.querySelectorAll('.sel-cb'),function(c){if(c.offsetParent!==null)c.checked=true;});update();});
  if(noneBtn) noneBtn.addEventListener('click',function(){Array.prototype.forEach.call(card.querySelectorAll('.sel-cb'),function(c){c.checked=false;});update();});
  btn.addEventListener('click', function(){
    var sel=[], idx=[];
    picked().forEach(function(c){
      var tr=c.closest('[data-rel],[data-idx]'); if(!tr) return;
      if(tr.hasAttribute('data-rel')) sel.push(tr.getAttribute('data-rel'));
      else idx.push(tr.getAttribute('data-idx'));
    });
    if(!sel.length && !idx.length) return;
    var f=document.createElement('form'); f.method='POST'; f.action=action; f.style.display='none';
    function add(name,val){ var i=document.createElement('input'); i.type='hidden'; i.name=name; i.value=val; f.appendChild(i); }
    if(sel.length) add('sel', sel.join('\\n'));
    if(idx.length) add('idx', idx.join('\\n'));
    document.body.appendChild(f); f.submit();
    setTimeout(function(){ try{document.body.removeChild(f);}catch(e){} },1500);
  });
})();</script>`;
function viewToggle(L) {
  return `<div class="view-toggle" role="group">`
    + `<button type="button" class="vt-btn active" data-view="list">${esc(L.viewList)}</button>`
    + `<button type="button" class="vt-btn" data-view="gallery">${esc(L.viewGallery)}</button>`
    + `</div>`;
}
// Selection toolbar: hidden until at least one row is ticked.
function selectBar(L) {
  return `<div class="sel-bar" style="display:none"><span class="sel-count">0</span> ${esc(L.selectedWord)}`
    + ` <button type="button" class="btn ghost sm sel-all">${esc(L.selectAll || 'All')}</button>`
    + ` <button type="button" class="btn ghost sm sel-none">${esc(L.selectNone || 'None')}</button>`
    + ` <button type="button" class="btn sm sel-zip">${esc(L.selectZip)}</button></div>`;
}
// Toggles List/Gallery on the card and remembers the choice (localStorage);
// also lazily assigns gallery thumbnail sources as tiles near the viewport.
const GALLERY_SCRIPT = `<script>(function(){
  var card=document.querySelector('.has-gallery'); if(!card) return;
  var btns=card.querySelectorAll('.vt-btn');
  function set(v){ card.setAttribute('data-view',v);
    Array.prototype.forEach.call(btns,function(x){x.classList.toggle('active',x.getAttribute('data-view')===v);});
    try{localStorage.setItem('dxview',v);}catch(e){} }
  Array.prototype.forEach.call(btns,function(b){ b.addEventListener('click',function(){set(b.getAttribute('data-view'));}); });
  try{ if(localStorage.getItem('dxview')==='gallery') set('gallery'); }catch(e){}

  var lazy=card.querySelectorAll('.g-media [data-src]');
  function load(el){
    var src=el.getAttribute('data-src');
    if(!src) return;
    el.src=src; el.removeAttribute('data-src');
    if(el.tagName==='VIDEO') el.preload='metadata';
  }
  if('IntersectionObserver' in window && lazy.length){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(!entry.isIntersecting) return;
        load(entry.target);
        io.unobserve(entry.target);
      });
    }, { rootMargin:'400px 0px', threshold:0.01 });
    Array.prototype.forEach.call(lazy,function(el){ io.observe(el); });
  } else {
    Array.prototype.forEach.call(lazy,load); // no IO support: load everything upfront
  }
})();</script>`;

// Optional admin message banner shown on public download pages (feature).
function shareNoteHtml(share) {
  if (!share) return '';
  const note = share.note ? `<div class="inbox-note"><span class="inbox-note-ico">💬</span><div class="inbox-note-txt">${esc(share.note).replace(/\n/g, '<br>')}</div></div>` : '';
  const description = share.descriptionMd ? `<div class="share-description md-body">${renderMarkdown(share.descriptionMd)}</div>` : '';
  return note + description;
}

// A per-type emoji for public folder/collection listings.
const FILE_TYPE_ICONS = (() => {
  const m = {};
  const set = (icon, exts) => exts.forEach((e) => { m[e] = icon; });
  set('🖼️', ['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif','tif','tiff','ico']);
  set('🎞️', ['mp4','mkv','mov','avi','webm','m4v','mpg','mpeg','wmv','flv']);
  set('🎵', ['mp3','wav','flac','ogg','oga','m4a','aac','opus','wma']);
  set('📕', ['pdf']);
  set('📘', ['doc','docx','odt','rtf','pages']);
  set('📗', ['xls','xlsx','ods','csv','tsv','numbers']);
  set('📙', ['ppt','pptx','odp','key']);
  set('📃', ['txt','md','markdown','log','nfo']);
  set('🗜️', ['zip','rar','7z','gz','tar','bz2','xz','tgz','zst']);
  set('📜', ['js','mjs','ts','tsx','jsx','json','html','htm','css','scss','py','java','c','h','cpp','cc','go','rs','rb','php','sh','bash','yml','yaml','xml','toml','ini','sql']);
  set('⚙️', ['exe','dmg','apk','deb','rpm','msi','app','bin','iso']);
  set('🔤', ['ttf','otf','woff','woff2','eot']);
  return m;
})();
function fileTypeIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return (ext && FILE_TYPE_ICONS[ext]) || '📄';
}

// Compact duration like "2j 4h" / "12min 5s" — used by the ETA estimate and the
// public expiry countdown. `unitsCsv` carries the localized unit letters.
function humanizeDurationShort(secs, unitsCsv, maxParts) {
  const u = String(unitsCsv || 'd,h,m,s').split(',');
  secs = Math.max(0, Math.round(Number(secs) || 0));
  const seg = [[Math.floor(secs / 86400), u[0]], [Math.floor((secs % 86400) / 3600), u[1]],
    [Math.floor((secs % 3600) / 60), u[2]], [secs % 60, u[3]]];
  const out = [];
  const cap = Math.max(1, Number(maxParts) || 2);
  for (let i = 0; i < seg.length; i++) {
    if (seg[i][0] > 0 || out.length) { out.push(seg[i][0] + seg[i][1]); if (out.length === cap) break; }
  }
  return out.length ? out.join(' ') : ('0' + u[3]);
}

// Server-rendered download-time estimate at two reference speeds.
function downloadEtaHtml(bytes, L) {
  const b = Number(bytes) || 0;
  if (b < 1024 * 1024) return ''; // not worth showing for < 1 MB
  const eta = (mbps) => humanizeDurationShort((b * 8) / (mbps * 1e6), L.durUnits, 2);
  return `<p class="dl-eta muted">${esc(L.etaLabel)} : ~${esc(eta(10))} (10 Mb/s) · ~${esc(eta(100))} (100 Mb/s)</p>`;
}

// Public "remaining slots" line — shown when the link caps its unique visitors.
// The current visitor is already counted by recordAndCheckVisitor before render,
// so the figure reflects how many NEW visitors may still open the link.
function visitorSlotsHtml(share, L) {
  const cap = parseMaxVisitors(share.maxVisitors);
  if (cap <= 0) return '';
  const used = Array.isArray(share.visitors) ? share.visitors.length : 0;
  const left = Math.max(0, cap - used);
  return `<p class="dl-slots muted">${esc(L.visitorSlots.replace('{v}', left).replace('{t}', cap))}</p>`;
}

// Estimated size of a "download all (.zip)": the sum of the known file sizes.
// Folders (whose recursive size isn't known at this listing level) and any file
// with an unknown size flag the total as approximate ("≈"). Returns '' when
// nothing is measurable, so a folder-only listing shows no misleading 0-byte hint.
function zipSizeEstimate(items) {
  let bytes = 0, approx = false;
  for (const it of items || []) {
    if (it && (it.type === 'folder' || it.isDir)) { approx = true; continue; }
    const n = Number(it && it.size) || 0;
    if (n > 0) bytes += n; else approx = true;
  }
  return { bytes, approx };
}
function zipEstHtml(items, L) {
  const { bytes, approx } = zipSizeEstimate(items);
  if (bytes <= 0) return '';
  return ` <span class="zip-est muted" title="${esc(L.zipEstTitle)}">(${approx ? '≈ ' : ''}${esc(formatBytes(bytes))})</span>`;
}

// A live expiry countdown element (COUNTDOWN_SCRIPT in pageShell
// updates it every second). Absent when the link has no effective deadline.
function expiryCountdownHtml(share, L) {
  const at = shareEffectiveExpiry(share);
  if (!at || at <= Date.now()) return '';
  return `<p class="dl-expiry muted" data-dx-expires="${at}" data-dx-units="${esc(L.durUnits)}" data-dx-gone="${esc(L.expired)}">`
    + `${esc(L.expiresIn)} <span class="dl-expiry-val"></span></p>`;
}

function collectionPage(lang, share, items, tk, wm) {
  const L = PUB[lang] || PUB.en;
  tk = tk || share.token; // token actually visited (main link or a recipient sub-link)
  const allowZip = zipAllowed(share);
  const media = [];
  const rows = items
    .map((it, i) => {
      if (it.type === 'folder') {
        const browse = `/s/${tk}/item/${i}/browse`;
        const zip = `/s/${tk}/item/${i}/zip`;
        const zipAct = allowZip ? `<a class="row-act" href="${esc(zip)}" rel="noopener">${esc(L.zipLabel)}</a>` : '';
        return `<tr data-name="${esc(String(it.name).toLowerCase())}" data-idx="${i}"><td class="fl-name"><span class="ico">📁</span> <a href="${esc(browse)}">${esc(it.name)}</a></td><td class="fl-size">—</td><td class="fl-act"><a class="row-act" href="${esc(browse)}">${esc(L.browseLabel)}</a>${zipAct}</td></tr>`;
      }
      const dl = `/s/${tk}/download?i=${i}`;
      const info = share.noPreview ? null : previewInfo(it.name);
      if (info && (info.kind === 'image' || info.kind === 'video')) {
        const url = `/s/${tk}/view?i=${i}`;
        media.push({ href: url, src: url, name: it.name, kind: info.kind });
      }
      const rk = share.noPreview ? null : renderKind(it.name);
      const view = rk
        ? `<a class="row-act" href="/s/${tk}/render?i=${i}" target="_blank" rel="noopener">${esc(L.preview)}</a>`
        : (info
          ? `<a class="row-act" href="/s/${tk}/view?i=${i}" target="_blank" rel="noopener">${esc(L.preview)}</a>`
          : '');
      return `<tr data-name="${esc(String(it.name).toLowerCase())}" data-idx="${i}"><td class="fl-name"><span class="ico">${fileTypeIcon(it.name)}</span> ${esc(it.name)}</td><td class="fl-size">${esc(formatBytes(it.size))}</td><td class="fl-act">${view}<a class="row-act" href="${esc(dl)}" download rel="noopener">${esc(L.download)}</a></td></tr>`;
    })
    .join('');
  const hasGallery = media.length > 0;
  const hasSearch = items.length > 4;
  const hasSelect = allowZip && items.length > 1;
  const selBar = hasSelect ? selectBar(L) : '';
  const controls = `<div class="fl-controls"><span class="fl-acts">${
    allowZip ? `<a class="row-act" href="/s/${tk}/all.zip">${esc(L.downloadAllZip)}</a>${zipEstHtml(items, L)}` : ''
  }<a class="row-act" href="/s/${tk}/sha256">${esc(L.checksums)}</a></span>${hasGallery ? viewToggle(L) : ''}</div>${hasSearch ? searchBox(L) : ''}`;
  const body = `
<div class="card${hasGallery ? ' has-gallery' : ''}${hasSearch ? ' has-search' : ''}${hasSelect ? ' has-select' : ''}" data-view="list" data-zipsel="/s/${esc(tk)}/zip-select">
  <h1><span class="ico">📦</span>${esc(share.name)}</h1>
  <p class="muted">${items.length} ${esc(L.itemsWord)}</p>
  ${visitorSlotsHtml(share, L)}
  ${expiryCountdownHtml(share, L)}
  ${shareNoteHtml(share)}
  ${controls}
  ${selBar}
  ${hasGallery ? galleryHtml(media, wm) : ''}
  <div class="list-view"><table class="filelist"><tbody>${rows}</tbody></table></div>
  ${hasSearch ? `<p class="fl-noresult muted" style="display:none">${esc(L.noResult)}</p>` : ''}
</div>${hasGallery ? GALLERY_SCRIPT : ''}${hasSearch ? SEARCH_SCRIPT : ''}${hasSelect ? SELECT_SCRIPT : ''}`;
  return pageShell(lang, share.name, body + feedbackSection(lang, share, tk));
}

function filePage(lang, share, downloadUrl, tk, wm) {
  const L = PUB[lang] || PUB.en;
  tk = tk || share.token; // token actually visited (main link or a recipient sub-link)
  const mediaName = share.previewName || share.name;
  const info = share.noPreview ? null : previewInfo(mediaName);
  const viewUrl = `/s/${tk}/view`;
  const wmHtml = watermarkOverlay(wm);
  let preview = '';
  if (info && info.kind === 'image') {
    preview = `<div class="preview"><img src="${esc(viewUrl)}" alt="${esc(share.name)}" loading="lazy">${wmHtml}</div>`;
  } else if (info && info.kind === 'video') {
    preview = `<div class="preview"><video src="${esc(viewUrl)}" data-dx-resume="1" data-dx-video-fallback="1" controls preload="metadata" playsinline></video>${wmHtml}<p class="vfallback muted" style="display:none">${esc(L.vidUnsupported)} <a href="${esc(downloadUrl)}" download>${esc(L.download)}</a></p></div>`;
  } else if (info && info.kind === 'audio') {
    preview = `<div class="preview preview-audio"><audio src="${esc(viewUrl)}" data-dx-resume="1" controls preload="metadata"></audio></div>`;
  } else if (info && info.kind === 'pdf') {
    preview = `<div class="pdf-preview-shell"><iframe class="pdf-preview-frame" src="${esc(viewUrl)}" title="${esc(share.name)}"></iframe></div>`;
  }
  const rk = share.noPreview || share.type === 'web-storage' ? null : renderKind(mediaName);
  const openBtn = rk
    ? `<a class="btn btn-ghost" href="/s/${tk}/render" target="_blank" rel="noopener">${esc(L.preview)}</a>`
    : (info && (info.kind === 'pdf' || info.kind === 'text')
      ? `<a class="btn btn-ghost" href="${esc(viewUrl)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`
      : '');
  const checksums = share.type === 'web-storage' ? '' : `<p class="file-sums"><a class="row-act" href="/s/${tk}/sha256">${esc(L.checksums)}</a></p>`;
  const body = `
<div class="card">
  <h1><span class="ico">📄</span>${esc(share.name)}</h1>
  <p class="muted">${esc(L.size)} : ${formatBytes(share.size)}</p>
  ${downloadEtaHtml(share.size, L)}
  ${visitorSlotsHtml(share, L)}
  ${expiryCountdownHtml(share, L)}
  ${shareNoteHtml(share)}
  ${preview}
  <div class="file-actions">${openBtn}<a class="btn" href="${esc(downloadUrl)}" download rel="noopener">${esc(L.download)}</a></div>
  ${checksums}
</div>`;
  return pageShell(lang, share.name, body + feedbackSection(lang, share, tk));
}

// Public page for an end-to-end-encrypted download share: the ciphertext is
// fetched and decrypted entirely in the visitor's browser (dxdecrypt.js).
function encDecryptPage(lang, share, token) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    token: token || share.token,
    mode: share.encMode || 'key',
    strings: {
      working: L.encDlWorking, downloading: L.encDlDownloading,
      badKey: L.encDlBadKey, keyMissing: L.encDlKeyMissing, ready: L.encDlReady,
    },
  };
  const passField = share.encMode === 'pass'
    ? `<label class="up-msg-label" for="enc-pass">${esc(L.encDlPassLabel)}</label>`
      + `<input type="password" id="enc-pass" class="up-msg" autocomplete="off">`
    : '';
  const body = `
<div class="card">
  <div class="enc-banner"><span class="enc-ico">🔒</span><span>${esc(L.encDlIntro)}</span></div>
  <h1><span class="ico">🔒</span>${esc(share.name)}</h1>
  ${passField}
  <button type="button" id="enc-go" class="btn block">${esc(L.encDlBtn)}</button>
  <div class="upbar enc-bar-wrap" id="enc-barwrap" style="display:none"><i id="enc-bar"></i></div>
  <p id="enc-status" class="up-limits muted"></p>
</div>
<script>window.DX_ENC=${jsonForScript(cfg)};</script>
<script src="/dxcrypto.js"></script>
<script src="/dxdecrypt.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Burn-after-read secret page. The ciphertext is fetched once (which
// burns it server-side) and decrypted entirely in the browser (dxsecret.js).
function secretPage(lang, token, mode) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    token,
    mode: mode || 'key',
    strings: {
      working: L.secretWorking, badKey: L.secretBadKey, keyMissing: L.secretKeyMissing,
      gone: L.secretGone, copied: L.copied, copy: L.secretCopy, oneShot: L.secretOneShot,
    },
  };
  const passField = mode === 'pass'
    ? `<label class="up-msg-label" for="secret-pass">${esc(L.secretPassLabel)}</label>`
      + `<input type="password" id="secret-pass" class="up-msg" autocomplete="off" placeholder="${esc(L.secretPassPh)}">`
    : '';
  const body = `
<div class="card">
  <div class="enc-banner"><span class="enc-ico">🔥</span><span>${esc(L.secretIntro)}</span></div>
  <h1><span class="ico">🔑</span>${esc(L.secretTitle)}</h1>
  ${passField}
  <button type="button" id="secret-go" class="btn block">${esc(L.secretReveal)}</button>
  <textarea id="secret-out" class="up-msg secret-out" rows="4" readonly style="display:none"></textarea>
  <button type="button" id="secret-copy" class="btn ghost sm" style="display:none">${esc(L.secretCopy)}</button>
  <p id="secret-status" class="up-limits muted"></p>
</div>
<script>window.DX_SECRET=${jsonForScript(cfg)};</script>
<script src="/dxcrypto.js"></script>
<script src="/dxsecret.js"></script>`;
  return pageShell(lang, L.secretTitle, body);
}

function buildCrumbs(share, relSub, browseBase) {
  const parts = relSub ? relSub.split('/').filter(Boolean) : [];
  const items = [`<a href="${esc(browseBase)}">${esc(share.name)}</a>`];
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    items.push(`<a href="${esc(browseBase + '/' + encodePath(acc))}">${esc(p)}</a>`);
  }
  return items.join(' / ');
}

function folderPage(lang, share, relSub, entries, links, wm) {
  const L = PUB[lang] || PUB.en;
  const crumbHtml = buildCrumbs(share, relSub, links.browseBase);
  const media = [];
  const rows = entries
    .map((e) => {
      if (e.isDir) {
        return `<tr data-name="${esc(String(e.name).toLowerCase())}" data-rel="${esc(e.rel)}"><td><span class="ico">📁</span><a href="${esc(links.browse(e.rel))}">${esc(
          e.name
        )}</a></td><td class="size">—</td><td class="fl-act"></td></tr>`;
      }
      const info = share.noPreview ? null : previewInfo(e.name);
      let previewLink = '';
      if (info && (info.kind === 'image' || info.kind === 'video')) {
        const url = links.file(e.rel) + '?view=1'; // inline (not attachment) for thumbnails
        media.push({ href: url, src: url, name: e.name, kind: info.kind });
      }
      const rk = share.noPreview ? null : renderKind(e.name);
      if (rk) {
        const url = links.file(e.rel) + '?render=1';
        previewLink = `<a class="row-act" href="${esc(url)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`;
      } else if (info) {
        const url = links.file(e.rel) + '?view=1';
        previewLink = `<a class="row-act" href="${esc(url)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`;
      }
      return `<tr data-name="${esc(String(e.name).toLowerCase())}" data-rel="${esc(e.rel)}"><td><span class="ico">${fileTypeIcon(e.name)}</span>${esc(e.name)}</td><td class="size">${formatBytes(
        e.size
      )}</td><td class="fl-act">${previewLink}<a class="row-act" href="${esc(
        links.file(e.rel)
      )}" download rel="noopener">${esc(L.download)}</a></td></tr>`;
    })
    .join('');
  const emptyRow = entries.length
    ? ''
    : `<tr><td colspan="3" class="muted">${esc(L.emptyFolder)}</td></tr>`;
  const zipBtn = zipAllowed(share)
    ? `<a class="btn sm" href="${esc(links.zip(relSub))}" rel="noopener">${esc(L.downloadAllZip)}</a>${zipEstHtml(entries, L)}`
    : '<span></span>';
  const hasGallery = media.length > 0;
  const hasSearch = entries.length > 4;
  const hasPlayable = !share.noPreview && entries.some((e) => {
    if (e.isDir) return false;
    const i = previewInfo(e.name);
    return i && (i.kind === 'video' || i.kind === 'audio');
  });
  const playerUrl = (relSub ? links.browse(relSub) : links.browseBase) + '?player=1';
  const playerBtn = hasPlayable ? `<a class="row-act" href="${esc(playerUrl)}">${esc(L.playerLabel)}</a>` : '';
  const sumsBtn = `<a class="row-act" href="${esc(links.sha256(relSub))}">${esc(L.checksums)}</a>`;
  const hasSelect = zipAllowed(share) && entries.length > 1;
  const selBar = hasSelect ? selectBar(L) : '';
  const controls = `<div class="fl-controls"><span class="fl-acts">${zipBtn}${sumsBtn}${playerBtn}</span>${hasGallery ? viewToggle(L) : ''}</div>${hasSearch ? searchBox(L) : ''}`;
  const body = `
<div class="card${hasGallery ? ' has-gallery' : ''}${hasSearch ? ' has-search' : ''}${hasSelect ? ' has-select' : ''}" data-view="list" data-zipsel="${esc(links.zip(relSub).replace(/\/zip(\/|$).*/, '/zip-select'))}">
  <h1><span class="ico">📁</span>${esc(share.name)}</h1>
  <p class="crumbs">${crumbHtml}</p>
  ${relSub ? '' : shareNoteHtml(share)}
  ${relSub ? '' : visitorSlotsHtml(share, L)}
  ${relSub ? '' : expiryCountdownHtml(share, L)}
  ${controls}
  ${selBar}
  ${hasGallery ? galleryHtml(media, wm) : ''}
  <div class="list-view"><table>
    <thead><tr><th>${esc(L.name)}</th><th>${esc(L.size)}</th><th></th></tr></thead>
    <tbody>${rows}${emptyRow}</tbody>
  </table></div>
  ${hasSearch ? `<p class="fl-noresult muted" style="display:none">${esc(L.noResult)}</p>` : ''}
</div>${hasGallery ? GALLERY_SCRIPT : ''}${hasSearch ? SEARCH_SCRIPT : ''}${hasSelect ? SELECT_SCRIPT : ''}`;
  return pageShell(lang, share.name, body);
}

// Folder browser for a web-storage share. Unlike a local folder share it never
// advertises ZIP/checksum operations, because the cloud tree is streamed on
// demand and is intentionally not materialized on the Direct-Xfer host.
function webStorageFolderPage(lang, share, relSub, entries, links, wm) {
  const L = PUB[lang] || PUB.en;
  const crumbHtml = buildCrumbs(share, relSub, links.browseBase);
  const media = [];
  const rows = entries.map((e) => {
    if (e.isDir) {
      return `<tr data-name="${esc(String(e.name).toLowerCase())}" data-rel="${esc(e.rel)}"><td><span class="ico">☁️</span><a href="${esc(links.browse(e.rel))}">${esc(e.name)}</a></td><td class="size">—</td><td class="fl-act"></td></tr>`;
    }
    const info = share.noPreview ? null : previewInfo(e.name);
    let previewLink = '';
    if (info && (info.kind === 'image' || info.kind === 'video')) {
      const url = links.file(e.rel) + '?view=1';
      media.push({ href:url, src:url, name:e.name, kind:info.kind });
    }
    if (info) {
      const url = links.file(e.rel) + '?view=1';
      previewLink = `<a class="row-act" href="${esc(url)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`;
    }
    return `<tr data-name="${esc(String(e.name).toLowerCase())}" data-rel="${esc(e.rel)}"><td><span class="ico">${fileTypeIcon(e.name)}</span>${esc(e.name)}</td><td class="size">${formatBytes(e.size)}</td><td class="fl-act">${previewLink}<a class="row-act" href="${esc(links.file(e.rel))}" download rel="noopener">${esc(L.download)}</a></td></tr>`;
  }).join('');
  const emptyRow = entries.length ? '' : `<tr><td colspan="3" class="muted">${esc(L.emptyFolder)}</td></tr>`;
  const hasGallery = media.length > 0;
  const hasSearch = entries.length > 4;
  const controls = `<div class="fl-controls"><span class="fl-acts"></span>${hasGallery ? viewToggle(L) : ''}</div>${hasSearch ? searchBox(L) : ''}`;
  const body = `
<div class="card${hasGallery ? ' has-gallery' : ''}${hasSearch ? ' has-search' : ''}" data-view="list">
  <h1><span class="ico">☁️</span>${esc(share.name)}</h1>
  <p class="crumbs">${crumbHtml}</p>
  ${relSub ? '' : shareNoteHtml(share)}
  ${relSub ? '' : visitorSlotsHtml(share, L)}
  ${relSub ? '' : expiryCountdownHtml(share, L)}
  ${controls}
  ${hasGallery ? galleryHtml(media, wm) : ''}
  <div class="list-view"><table>
    <thead><tr><th>${esc(L.name)}</th><th>${esc(L.size)}</th><th></th></tr></thead>
    <tbody>${rows}${emptyRow}</tbody>
  </table></div>
  ${hasSearch ? `<p class="fl-noresult muted" style="display:none">${esc(L.noResult)}</p>` : ''}
</div>${hasGallery ? GALLERY_SCRIPT : ''}${hasSearch ? SEARCH_SCRIPT : ''}`;
  return pageShell(lang, share.name, body);
}

function errorPage(lang, code, message) {
  const body = `
<div class="card">
  <h1>${esc(code)}</h1>
  <p class="muted">${esc(message)}</p>
</div>`;
  return pageShell(lang, String(code), body);
}

// Public image gallery: a lightweight, theme-aware grid of an
// album's member images. Each thumbnail links to the full-size image. All URLs
// are same-origin (/i/<token>…) so they always load and stay hotlink-safe.
function albumPage(lang, album, members, req) {
  const L = PUB[lang] || PUB.en;
  const title = album.name || (L.albumTitle || 'Gallery');
  const cells = members.map((m) => {
    const full = '/i/' + m.token + '/auto?w=1920';
    const thumb = '/i/' + m.token + '/auto?w=480';
    const privacy = m.metadataRemoved ? `<span class="gal-privacy">🛡 ${esc(L.photoMetadataRemoved || 'EXIF/GPS removed')}</span>` : '';
    return `<a class="gal-cell" href="${esc(full)}" target="_blank" rel="noopener" title="${esc(m.name || '')}">`
      + `<img loading="lazy" src="${esc(thumb)}" alt="${esc(m.name || '')}">${privacy}</a>`;
  }).join('');
  const countTxt = (L.albumCount || '{n} images').replace('{n}', members.length);
  const body = `
<style>
  .gal-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  .gal-head h1 { margin:0; font-size:1.4rem; word-break:break-word; }
  .gallery-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .gal-cell { position:relative; display:block; aspect-ratio:1/1; border-radius:10px; overflow:hidden; background:var(--card-2,rgba(127,127,127,.12)); }
  .gal-cell img { width:100%; height:100%; object-fit:cover; display:block; transition:transform .2s ease; }
  .gal-cell:hover img { transform:scale(1.05); }
  .gal-privacy { position:absolute; left:7px; bottom:7px; max-width:calc(100% - 14px); padding:4px 7px; border-radius:999px; background:rgba(8,24,18,.86); color:#d9ffe9; font-size:.72rem; font-weight:700; line-height:1.2; }
  .gal-empty { text-align:center; padding:36px 0; }
</style>
<div class="card">
  <div class="gal-head"><h1>${esc(title)}</h1><span class="muted">${esc(countTxt)}</span></div>
  ${members.length ? `<div class="gallery-grid">${cells}</div>` : `<p class="gal-empty muted">${esc(L.albumEmpty || 'No images.')}</p>`}
</div>`;
  return pageShell(lang, title, body);
}

// Human-readable summary of a reception link's limits (for the public page).
// The "files left" and "quota left" segments are wrapped in spans with fixed
// ids (up-limit-files / up-limit-quota) so reception.js can refresh just
// those numbers after each upload, instead of only reflecting the counts at
// the time the page was first rendered. Each part is pre-escaped here since
// the caller now inserts the joined string as raw HTML (to allow the spans).
function inboxLimitsText(L, s) {
  const parts = [];
  if (s.maxFileBytes > 0) parts.push(esc(L.limitPerFile.replace('{v}', formatBytes(s.maxFileBytes))));
  if (s.maxTotalBytes > 0) {
    const left = Math.max(0, s.maxTotalBytes - (s.bytesReceived || 0));
    const txt = L.limitQuota.replace('{v}', formatBytes(left)).replace('{t}', formatBytes(s.maxTotalBytes));
    parts.push(`<span id="up-limit-quota">${esc(txt)}</span>`);
  }
  if (s.maxFiles > 0) {
    const txt = L.limitFiles.replace('{v}', Math.max(0, s.maxFiles - (s.downloads || 0))).replace('{t}', s.maxFiles);
    parts.push(`<span id="up-limit-files">${esc(txt)}</span>`);
  }
  if (s.maxFilesPerUpload > 0) parts.push(esc(L.limitFilesPerUpload.replace('{v}', s.maxFilesPerUpload)));
  if (Array.isArray(s.allowExt) && s.allowExt.length) parts.push(esc(L.limitAllow.replace('{v}', s.allowExt.join(', '))));
  if (Array.isArray(s.blockExt) && s.blockExt.length) parts.push(esc(L.limitBlock.replace('{v}', s.blockExt.join(', '))));
  return parts.join(' · ');
}

// Playlist player for the audio/video files of a folder. Auto-loads
// sibling subtitles (.vtt/.srt) for videos and auto-advances through the list.
function mediaPlayerPage(lang, share, entries, links, wm) {
  const L = PUB[lang] || PUB.en;
  const relByName = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name, e.rel]));
  const items = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const info = previewInfo(e.name);
    if (!info || (info.kind !== 'video' && info.kind !== 'audio')) continue;
    const subs = info.kind === 'video'
      ? subtitleTracksFor(e.name, entries).map((tr) => ({
          src: links.file(relByName.get(tr.name)) + '?vtt=1', label: tr.label, lang: tr.lang || 'und',
        }))
      : [];
    items.push({ name: e.name, src: links.file(e.rel) + '?view=1', dl: links.file(e.rel), kind: info.kind, subs });
  }
  const cfg = { items, strings: { subsOff: L.subsOff } };
  const backUrl = links.browseBase;
  if (!items.length) {
    const empty = `<div class="card"><h1><span class="ico">🎬</span>${esc(share.name)}</h1>`
      + `<p class="muted">${esc(L.noMedia)}</p><div class="file-actions"><a class="btn" href="${esc(backUrl)}">${esc(L.backToFiles)}</a></div></div>`;
    return pageShell(lang, share.name, empty);
  }
  const list = items.map((m, i) =>
    `<li class="dxp-track" data-i="${i}"><span class="dxp-ico">${m.kind === 'video' ? '🎬' : '🎵'}</span><span class="dxp-name">${esc(m.name)}</span></li>`
  ).join('');
  const body = `
<div class="card render-card">
  <h1><span class="ico">▶</span>${esc(share.name)}</h1>
  <div class="dxp-stage">
    <video id="dxp-video" data-dx-resume="1" controls playsinline preload="metadata"></video>
    ${watermarkOverlay(wm)}
  </div>
  <p id="dxp-now" class="muted dxp-now"></p>
  <ol class="dxp-list">${list}</ol>
  <div class="file-actions"><a class="btn btn-ghost" href="${esc(backUrl)}">${esc(L.backToFiles)}</a><a id="dxp-dl" class="btn" download rel="noopener">${esc(L.download)}</a></div>
</div>
<script>window.DX_PLAYER=${jsonForScript(cfg)};</script>
<script src="/dxplayer.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Public reception page (file upload by the visitor).
function inboxPage(lang, share) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    maxFiles: share.maxFiles || 0,
    maxFilesPerUpload: share.maxFilesPerUpload || 0, // per-deposit file-count cap
    maxFileBytes: share.maxFileBytes || 0,
    maxTotalBytes: share.maxTotalBytes || 0,
    bytesReceived: share.bytesReceived || 0,
    filesReceived: share.downloads || 0,
    allowExt: Array.isArray(share.allowExt) ? share.allowExt : [],
    blockExt: Array.isArray(share.blockExt) ? share.blockExt : [],
    // Localized templates, reused client-side to refresh the "left" counts
    // in place after each upload instead of just reflecting page-load values.
    limitFilesTpl: L.limitFiles,
    limitQuotaTpl: L.limitQuota,
    enc: share.encrypted ? { on: true, mode: share.encMode || 'key' } : null,
    encStrings: share.encrypted ? { encrypting: L.encEncrypting, passRequired: L.encPassRequired, keyMissing: L.encKeyMissing } : null,
    groupBySender: !!share.groupBySender, // ask the visitor for a name → per-sender subfolder
    requireSenderName: !!share.requireSenderName, // the name is mandatory
    rejectDuplicates: !!share.rejectDuplicates,
    blockExecutables: !!share.blockExecutables,
    moderated: !!share.moderated,
    maxFilesPerSender: share.maxFilesPerSender || 0,
    maxBytesPerSender: share.maxBytesPerSender || 0,
    senderRequiredMsg: L.senderRequired,
    folderStrings: {
      prompt: L.newFolderPrompt, created: L.folderCreated, fail: L.folderCreateFail,
      invalid: L.folderInvalid, exists: L.folderExists, busy: L.folderBusy,
      destination: L.uploadDestination,
    },
    token: share.token,                        // reception thread endpoint
    threadEnabled: receptionThreadEnabled(share), // two-way conversation
  };
  const accept = cfg.allowExt.length ? ` accept="${esc(cfg.allowExt.map((e) => '.' + e).join(','))}"` : '';
  const limits = inboxLimitsText(L, share);
  const limitsHtml = limits ? `<p class="up-limits muted">${limits}</p>` : '';
  const preflightBits = [];
  if (limits) preflightBits.push(`<div class="up-preflight-limits">${limits}</div>`);
  if (share.rejectDuplicates) preflightBits.push(`<div>♻ ${esc(L.inboxDuplicatePolicy)}</div>`);
  if (share.requireSenderName) preflightBits.push(`<div>👤 ${esc(L.inboxSenderPolicy)}</div>`);
  if (share.blockExecutables) preflightBits.push(`<div>🛡 ${esc(L.inboxExecPolicy)}</div>`);
  if (share.moderated) preflightBits.push(`<div>🕓 ${esc(L.inboxModeratedPolicy)}</div>`);
  const preflightHtml = `<section class="up-preflight"><strong>${esc(L.inboxRestrictions)}</strong><span class="muted">${esc(L.inboxRestrictionsHint)}</span>${preflightBits.length ? `<div class="up-preflight-grid">${preflightBits.join('')}</div>` : ''}</section>`;
  // Admin instructions shown to the visitor (multi-line, plain text).
  const noteHtml = shareNoteHtml(share);
  // End-to-end encryption banner + (passphrase mode) a passphrase field.
  const encHtml = share.encrypted
    ? `<div class="enc-banner"><span class="enc-ico">🔒</span><span>${esc(L.encInboxBanner)}</span></div>`
      + (share.encMode === 'pass'
        ? `<label class="up-msg-label" for="up-passphrase">${esc(L.encPassLabel)}</label>`
          + `<input type="password" id="up-passphrase" class="up-msg" autocomplete="off" placeholder="${esc(L.encPassPh)}">`
        : '')
    : '';
  const cryptoScript = share.encrypted ? '<script src="/dxcrypto.js"></script>' : '';
  const body = `
<div class="card inbox-card">
  <div class="inbox-head">
    <span class="inbox-badge">📥</span>
    <div class="inbox-head-txt">
      <h1>${esc(share.name)}</h1>
      <p class="muted">${esc(L.inboxIntro)}</p>
    </div>
  </div>
  ${noteHtml}
  ${encHtml}
  ${(share.groupBySender || share.requireSenderName) ? `<label class="up-msg-label" for="up-sender">${esc(L.senderLabel)}${share.requireSenderName ? ' <span class="req">*</span>' : ''}</label><input type="text" id="up-sender" class="up-msg" maxlength="60" autocomplete="name"${share.requireSenderName ? ' required aria-required="true"' : ''} placeholder="${esc(L.senderPh)}">` : ''}
  ${preflightHtml}
  <label class="up-drop" id="up-drop">
    <input type="file" id="up-input" multiple hidden${accept}>
    <span class="up-drop-ico">⬆</span>
    <span class="up-drop-title">${esc(L.inboxHint)}</span>
    <span class="up-drop-sub">${esc(L.inboxHint2)}</span>
  </label>
  <input type="file" id="up-input-dir" webkitdirectory directory multiple hidden>
  <div class="up-modes">
    <button type="button" id="up-pick-files" class="btn ghost sm">${esc(L.inboxPickFiles)}</button>
    <button type="button" id="up-pick-dir" class="btn ghost sm">${esc(L.inboxPickFolder)}</button>
    <button type="button" id="up-new-folder" class="btn ghost sm">${esc(L.newFolder)}</button>
  </div>
  <p id="up-folder-current" class="up-folder-current" hidden></p>
  <div id="up-overall" class="up-overall" hidden></div>
  <div id="up-list-tools" class="up-list-tools" hidden>
    <span id="up-list-count" class="up-list-count muted"></span>
    <button type="button" id="up-clear" class="btn ghost sm"></button>
  </div>
  <div id="up-list" class="up-list"></div>
  <label class="up-msg-label" for="up-message">${esc(L.msgLabel)}</label>
  <textarea id="up-message" class="up-msg" rows="2" maxlength="2000" placeholder="${esc(L.msgPh)}"></textarea>
  <button type="button" id="up-send" class="btn block" disabled>${esc(L.inboxSend)}</button>
</div>
${receptionThreadEnabled(share) ? '<div class="card up-thread-card" id="up-thread" hidden></div>' : ''}
<script>window.DX_INBOX=${jsonForScript(cfg)};</script>
${cryptoScript}
<script src="/reception.js?v=16101"></script>`;
  return pageShell(lang, share.name, body);
}

// Collaboration page: a live, two-way shared folder. The visitor browses/downloads
// the current contents (fetched from /c/:token/list and refreshed live), uploads
// new files (chunked, resumable — same protocol as reception links) and, when the
// link allows it, deletes items. Driven by /dxcollab.js.
function collabPage(lang, share) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    token: share.token,
    allowDelete: !!share.allowDelete,
    allowZip: !share.webStorage && share.allowZip !== false,
    maxFileBytes: share.maxFileBytes || 0,
    maxTotalBytes: share.maxTotalBytes || 0,
    maxFiles: share.maxFiles || 0,
    maxFilesPerUpload: share.maxFilesPerUpload || 0, // per-deposit file-count cap
    allowExt: Array.isArray(share.allowExt) ? share.allowExt : [],
    blockExt: Array.isArray(share.blockExt) ? share.blockExt : [],
    strings: {
      download: L.download, del: L.collabDelete, delConfirm: L.collabDeleteConfirm,
      deleted: L.collabDeleted, delFail: L.collabDeleteFail, uploaded: L.collabUploaded,
      uploadFail: L.collabUploadFail, parent: L.collabParent, refresh: L.collabRefresh,
      empty: L.emptyFolder, home: L.collabHome, name: L.name, size: L.size,
      error: L.readError, quota: L.limitQuota, newFolder: L.newFolder,
      folderPrompt: L.newFolderPrompt, folderCreated: L.folderCreated,
      folderFail: L.folderCreateFail, folderInvalid: L.folderInvalid,
      folderExists: L.folderExists, folderBusy: L.folderBusy,
      perUploadLimit: L.limitFilesPerUpload, // per-deposit file-count cap
    },
  };
  const accept = cfg.allowExt.length ? ` accept="${esc(cfg.allowExt.map((e) => '.' + e).join(','))}"` : '';
  const limits = inboxLimitsText(L, share);
  const limitsHtml = limits ? `<p class="up-limits muted">${limits}</p>` : '';
  const noteHtml = shareNoteHtml(share);
  const zipBtn = cfg.allowZip
    ? `<a class="btn ghost sm" id="cl-zip" href="/c/${esc(share.token)}/zip" rel="noopener">${esc(L.downloadAllZip)}</a>` : '';
  const sumsBtn = share.webStorage ? '' : `<a class="btn ghost sm" href="/c/${esc(share.token)}/sha256" rel="noopener">${esc(L.checksums)}</a>`;
  const body = `
<div class="card collab-card">
  <div class="inbox-head">
    <span class="inbox-badge">🔁</span>
    <div class="inbox-head-txt">
      <h1>${esc(share.name)}</h1>
      <p class="muted">${esc(L.collabIntro)}</p>
    </div>
  </div>
  ${noteHtml}
  <div class="collab-bar">
    <p class="crumbs" id="cl-crumbs"></p>
    <div class="collab-bar-actions">${zipBtn}${sumsBtn}<button type="button" id="cl-new-folder" class="btn ghost sm">${esc(L.newFolder)}</button><button type="button" id="cl-refresh" class="btn ghost sm">${esc(L.collabRefresh)}</button></div>
  </div>
  <div id="cl-list" class="collab-list"></div>
  ${limitsHtml}
  <label class="up-drop" id="up-drop">
    <input type="file" id="up-input" multiple hidden${accept}>
    <span class="up-drop-ico">⬆</span>
    <span class="up-drop-title">${esc(L.inboxHint)}</span>
    <span class="up-drop-sub">${esc(L.inboxHint2)}</span>
  </label>
  <input type="file" id="up-input-dir" webkitdirectory directory multiple hidden>
  <div class="up-modes">
    <button type="button" id="up-pick-files" class="btn ghost sm">${esc(L.inboxPickFiles)}</button>
    <button type="button" id="up-pick-dir" class="btn ghost sm">${esc(L.inboxPickFolder)}</button>
  </div>
  <div id="up-list" class="up-list"></div>
</div>
<script>window.DX_COLLAB=${jsonForScript(cfg)};</script>
<script src="/dxcollab.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Password entry page for a protected link.
function passwordPage(lang, s, error, token) {
  const L = PUB[lang] || PUB.en;
  // Use the token actually being visited: a nominative sub-link keeps its own
  // token through the unlock, so downloads stay attributed to that recipient.
  const rel = linkPrefix(s) + (token || s.token);
  const body = `
<div class="card">
  <h1><span class="ico">🔒</span>${esc(s.name)}</h1>
  <p class="muted">${esc(L.pwPrompt)}</p>
  ${s.pwHint ? `<p class="pw-hint"><span class="ico">💡</span>${esc(s.pwHint)}</p>` : ''}
  ${error ? `<p class="err">${esc(L.pwWrong)}</p>` : ''}
  <form method="post" action="${esc(rel)}/unlock">
    <input class="pw" type="password" name="password" required autofocus placeholder="${esc(L.pwField)}">
    <button class="btn" type="submit">${esc(L.pwSubmit)}</button>
  </form>
</div>`;
  return pageShell(lang, s.name, body);
}

// The public "request access" page: a form for a fresh visitor, or a
// pending / denied status for a browser that already submitted (matched by cookie).
function accessRequestPage(lang, s, token, existing) {
  const L = PUB[lang] || PUB.en;
  const rel = linkPrefix(s) + (token || s.token);
  let inner;
  if (existing && existing.status === 'pending') {
    inner = `<h1><span class="ico">⏳</span>${esc(s.name)}</h1>
  <p class="muted">${esc(L.reqPending)}</p>
  <p class="up-limits muted">${esc(L.reqPendingHint)}</p>`;
  } else if (existing && existing.status === 'denied') {
    inner = `<h1><span class="ico">🚫</span>${esc(s.name)}</h1>
  <p class="err">${esc(L.reqDenied)}</p>`;
  } else {
    inner = `<h1><span class="ico">🔐</span>${esc(s.name)}</h1>
  <p class="muted">${esc(L.reqPrompt)}</p>
  <form method="post" action="${esc(rel)}/request-access">
    <input class="pw" type="text" name="name" required autofocus maxlength="80" placeholder="${esc(L.reqName)}">
    <input class="pw" type="email" name="email" maxlength="200" placeholder="${esc(L.reqEmail)}">
    <textarea class="up-msg" name="message" rows="3" maxlength="1000" placeholder="${esc(L.reqMessage)}"></textarea>
    <button class="btn" type="submit">${esc(L.reqSubmit)}</button>
  </form>`;
  }
  // Auto-reload a pending page so an admin approval lets the visitor in without a
  // manual refresh (inline scripts are allowed on public pages, see encDecryptPage).
  const auto = (existing && existing.status === 'pending') ? '<script>setTimeout(function(){location.reload();},20000);</script>' : '';
  return pageShell(lang, s.name, `<div class="card">${inner}</div>${auto}`);
}

// A moderated visitor-feedback form appended to a shared file's page.
// Submissions are private to the admin (never shown to other visitors). It is a
// plain <form> POST + redirect, so it works without JavaScript.
function feedbackSection(lang, share, tk) {
  if (!share.allowFeedback) return '';
  const L = PUB[lang] || PUB.en;
  const rel = linkPrefix(share) + (tk || share.token);
  return `
<div class="card fb-card">
  <h2><span class="ico">💬</span>${esc(L.fbTitle)}</h2>
  <p class="ok fb-thanks" id="fb-thanks" style="display:none">${esc(L.fbThanks)}</p>
  <form class="fb-form" method="post" action="${esc(rel)}/feedback">
    <input class="up-msg" type="text" name="name" maxlength="80" placeholder="${esc(L.fbName)}">
    <textarea class="up-msg" name="body" rows="3" required maxlength="2000" placeholder="${esc(L.fbBody)}"></textarea>
    <button class="btn" type="submit">${esc(L.fbSubmit)}</button>
  </form>
  <script>(function(){if(location.search.indexOf('feedback=sent')>=0){var t=document.getElementById('fb-thanks');if(t)t.style.display='block';var f=document.querySelector('.fb-form');if(f)f.style.display='none';try{history.replaceState(null,'',location.pathname);}catch(e){}}})();</script>
</div>`;
}

// Interstitial shown before a large download when the visitor has no
// valid proof-of-work pass. /dxpow.js solves the challenge in the browser and
// reloads the page (the pass rides in a cookie), continuing to the download.
function challengePage(lang) {
  const L = PUB[lang] || PUB.en;
  const body = `
<div class="card">
  <h1><span class="ico">🛡️</span>${esc(L.chalTitle)}</h1>
  <p class="muted">${esc(L.chalIntro)}</p>
  <div class="upbar enc-bar-wrap" id="pow-barwrap"><i id="pow-bar" style="width:0"></i></div>
  <p id="pow-status" class="up-limits muted" data-verify="${esc(L.chalVerify)}" data-fail="${esc(L.chalFail)}">${esc(L.chalWorking)}</p>
  <noscript><p class="err">${esc(L.chalNoJs)}</p></noscript>
</div>
<script src="/dxpow.js"></script>`;
  return pageShell(lang, L.chalTitle, body);
}

// ===================================================================
//  PUBLIC ROUTES: download (no authentication)
// ===================================================================


  return {
    PUB,
    pickLang,
    brandName,
    previewWatermark,
    pageShell,
    collectionPage,
    filePage,
    encDecryptPage,
    secretPage,
    folderPage,
    webStorageFolderPage,
    errorPage,
    albumPage,
    mediaPlayerPage,
    inboxPage,
    collabPage,
    passwordPage,
    accessRequestPage,
    feedbackSection,
    challengePage,
  };
}

module.exports = { createPublicPages };

