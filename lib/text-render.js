'use strict';

const { esc } = require('./core-utils');

const CODE_EXTS = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'py', 'sh', 'bash', 'zsh',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'toml', 'ini', 'conf',
  'yml', 'yaml', 'json', 'xml', 'html', 'htm', 'lua', 'pl', 'kt', 'swift', 'r', 'dart'];
const TEXT_EXTS = ['txt', 'log', 'csv', 'tsv', 'properties', 'env', 'cfg'];

function renderKind(filename) {
  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'zip') return 'archive';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (CODE_EXTS.includes(ext)) return 'code';
  if (TEXT_EXTS.includes(ext)) return 'text';
  const name = String(filename);
  if (/(^|\/)(dockerfile|makefile|gemfile|procfile|rakefile|vagrantfile|jenkinsfile)$/i.test(name)) return 'code';
  if (/(^|\/)\.env(?:\.[^/]+)?$/i.test(name)) return 'text';
  return null;
}

// A cross-language keyword set — enough for a lightweight, grammar-free highlight
// that colors keywords/strings/comments/numbers without pulling in a big lib.
const CODE_KEYWORDS = new Set(('await async function return if else for while do switch case break continue ' +
  'const let var new class extends super this import from export default try catch finally throw typeof ' +
  'instanceof in of void delete yield public private protected static get set interface enum implements ' +
  'package def elif except with as pass lambda global nonlocal print None True False and or not is ' +
  'struct impl fn mut pub use mod match trait where self crate func type map range chan go defer select ' +
  'end then begin nil echo require include namespace foreach elseif fun val when object override ' +
  'int float double char bool boolean string void long short unsigned signed enum union sizeof').split(/\s+/));

// Escape then tokenize the ESCAPED text in a single left-to-right pass, so span
// wrapping never breaks HTML and strings correctly swallow their contents (a
// `//` inside a quote is not mistaken for a comment). Grammar-free but effective.
// Groups: 1 block comment, 2 line comment, 3 string, 4 number, 5 word.
const CODE_TOKEN_RE = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*|#[^\n]*)|(&quot;(?:[^&\n]|&(?!quot;))*?&quot;|&#39;(?:[^&\n]|&(?!#39;))*?&#39;|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b)|(\b[A-Za-z_]\w*\b)/g;
function highlightCode(text) {
  return esc(text).replace(CODE_TOKEN_RE, (m, c1, c2, c3, c4, c5) => {
    if (c1 || c2) return `<span class="tok-c">${m}</span>`;
    if (c3) return `<span class="tok-s">${m}</span>`;
    if (c4) return `<span class="tok-n">${m}</span>`;
    if (c5) return CODE_KEYWORDS.has(c5) ? `<span class="tok-k">${m}</span>` : m;
    return m;
  });
}

// Minimal, safe Markdown → HTML. Everything is HTML-escaped first; only a known
// set of inline/block constructs is then re-introduced. No raw HTML passthrough.
function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${esc(u)}" target="_blank" rel="noopener nofollow">${t}</a>`);
  const out = [];
  let inCode = false, codeBuf = [], listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (let raw of lines) {
    const fence = /^```/.test(raw);
    if (fence) {
      if (inCode) { out.push(`<pre class="code">${esc(codeBuf.join('\n'))}</pre>`); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (/^\s*$/.test(raw)) { closeList(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(raw))) { closeList(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(raw)) { closeList(); out.push('<hr>'); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(raw))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(raw))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(raw))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (inCode) out.push(`<pre class="code">${esc(codeBuf.join('\n'))}</pre>`);
  closeList();
  return out.join('\n');
}

// List a ZIP's entries by parsing its End-Of-Central-Directory record
// and central directory, without extracting anything (no external dependency).

module.exports = { renderKind, highlightCode, renderMarkdown };
