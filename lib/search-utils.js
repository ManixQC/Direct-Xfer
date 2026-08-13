'use strict';

function normalizeSearchText(v) {
  return String(v == null ? '' : v).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\u0000/g, ' ');
}
function searchTokens(v) {
  // Keep filename/e-mail punctuation *inside* tokens, but never let sentence
  // punctuation at the right edge become part of the posting key (e.g. `word.`).
  // Otherwise a query for `word` misses content ending a sentence with `word.`.
  const raw = normalizeSearchText(v).match(/[a-z0-9][a-z0-9._@+-]{0,63}/g) || [];
  const out = raw.map((tok) => tok.replace(/[._@+-]+$/g, '')).filter((tok) => tok.length >= 2);
  return [...new Set(out.slice(0, 20000))];
}

// Local semantic search.  This deliberately avoids a cloud model:
// Direct-Xfer expands common French/English/Spanish concepts, applies a tiny
// language-agnostic stemmer, then ranks documents by weighted concept overlap.
// It is not an LLM embedding service, but it provides semantic recall for common
// document intents (invoice/bill/relevé, contract/agreement, electricity/hydro,
// receipts, identity, banking, etc.) while keeping indexed content on the server.
const SEMANTIC_GROUPS = {
  invoice:['invoice','bill','billing','facture','facturation','releve','statement','recibo','factura'],
  receipt:['receipt','recu','reçu','ticket','proof','preuve','comprobante'],
  contract:['contract','agreement','contrat','entente','convention','acuerdo','contrato'],
  signed:['signed','signature','signe','signé','signee','signée','firmado','firma'],
  electricity:['electricity','electric','hydro','power','energie','énergie','electricite','électricité','electrique','électrique','energia','energía'],
  water:['water','eau','aqueduc','agua'],
  internet:['internet','telecom','télécom','wifi','broadband','fibre','fiber'],
  phone:['phone','telephone','téléphone','mobile','cellulaire','celular'],
  bank:['bank','banking','banque','bancaire','banco'],
  tax:['tax','taxes','impot','impôt','fiscal','revenue','revenu','impuesto'],
  insurance:['insurance','assurance','policy','police','seguro'],
  medical:['medical','health','sante','santé','clinique','hospital','hôpital','medico','médico','salud'],
  identity:['identity','identite','identité','passport','passeport','license','licence','permis','id','identidad','pasaporte'],
  salary:['salary','payroll','paystub','salaire','paie','paye','nomina','nómina'],
  photo:['photo','image','picture','image','photographie','foto'],
  video:['video','vidéo','movie','film'],
  archive:['archive','zip','compressed','compresse','compressé'],
  project:['project','projet','proyecto'],
  report:['report','rapport','compte-rendu','informe'],
  july:['july','juillet','julio'], january:['january','janvier','enero'], february:['february','fevrier','février','febrero'],
  march:['march','mars','marzo'], april:['april','avril','abril'], may:['may','mai','mayo'], june:['june','juin','junio'],
  august:['august','aout','août','agosto'], september:['september','septembre','septiembre'], october:['october','octobre','octubre'],
  november:['november','novembre','noviembre'], december:['december','decembre','décembre','diciembre'],
};
const SEMANTIC_ALIAS = (() => {
  const m = new Map();
  for (const [canon, aliases] of Object.entries(SEMANTIC_GROUPS)) {
    m.set(normalizeSearchText(canon), canon);
    for (const a of aliases) m.set(normalizeSearchText(a), canon);
  }
  return m;
})();
function semanticStem(tok) {
  tok = normalizeSearchText(tok).replace(/[^a-z0-9]/g, '');
  if (tok.length <= 4) return tok;
  for (const suf of ['ements','ement','ations','ation','ments','ment','iques','ique','ingly','ingly','ing','ées','ees','ée','ee','ados','adas','ado','ada','idos','idas','ido','ida','es','s']) {
    if (tok.length > suf.length + 3 && tok.endsWith(suf)) { tok = tok.slice(0, -suf.length); break; }
  }
  return tok;
}
function semanticTerms(v) {
  const raw = normalizeSearchText(v).match(/[a-z0-9][a-z0-9._@+-]{0,63}/g) || [];
  const out = [];
  for (let tok of raw.slice(0, 30000)) {
    tok = tok.replace(/[._@+-]+$/g, ''); if (tok.length < 2) continue;
    const canonical = SEMANTIC_ALIAS.get(tok);
    // Known synonyms collapse to one language-neutral concept. Keeping both the
    // alias stem and the canonical term would dilute cross-language coverage
    // (e.g. `facture` vs `bill`) even though they mean the same thing. Unknown
    // terms still get a light stem so names and domain-specific words remain useful.
    if (canonical) out.push(canonical);
    else {
      const stem = semanticStem(tok);
      // Inflected aliases such as `factures`, `contrats` or `receipts` must be
      // canonicalized *after* stemming too. Previously they became `facture`,
      // `contrat`, etc. and no longer matched the cross-language concept key.
      const stemCanonical = stem ? SEMANTIC_ALIAS.get(stem) : null;
      if (stemCanonical) out.push(stemCanonical);
      else if (stem && stem.length >= 2) out.push(stem);
    }
  }
  return [...new Set(out)].slice(0, 4096);
}

module.exports = { SEMANTIC_GROUPS, normalizeSearchText, searchTokens, semanticStem, semanticTerms };
