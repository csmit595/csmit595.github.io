// Small shared helpers.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}
/** Replace an element's children (ignores false/null, flattens lists). */
export function fill(el, ...kids) { el.textContent = ''; add(el, kids); return el; }
export const uid = () => {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
};
export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const stripHtml = html => { const d = new DOMParser().parseFromString(html || '', 'text/html'); return d.body.textContent || ''; };
export const fmtTime = t => {
  if (!t) return '';
  let [H, M] = t.split(':').map(Number);
  const ap = H >= 12 ? 'PM' : 'AM'; H = H % 12 || 12;
  return M ? `${H}:${pad(M)} ${ap}` : `${H} ${ap}`;
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (s, long) => {
  const t = today();
  if (s === t) return 'Today';
  if (s === addDays(t, 1)) return 'Tomorrow';
  if (s === addDays(t, -1)) return 'Yesterday';
  const d = fromYmd(s);
  const diff = Math.round((d - fromYmd(t)) / 864e5);
  if (!long && diff > 1 && diff < 7) return DOW[d.getDay()];
  const base = `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
};
export const fmtSize = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';

// Very small Markdown-to-HTML converter (used for notes written by Claude and plain-text clips).
export function mdToHtml(md) {
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list.tag}>`); list = null; } };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd(); let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/))) {
      if (!list || list.kind !== 'todo') { close(); out.push('<ul class="todo">'); list = { tag: 'ul', kind: 'todo' }; }
      out.push(`<li${m[1] !== ' ' ? ' data-checked="1"' : ''}>${inline(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (!list || list.kind !== 'ul') { close(); out.push('<ul>'); list = { tag: 'ul', kind: 'ul' }; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (!list || list.kind !== 'ol') { close(); out.push('<ol>'); list = { tag: 'ol', kind: 'ol' }; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) close();
    else { close(); out.push(`<div>${inline(line)}</div>`); }
  }
  close();
  return out.join('');
}

// Make HTML from outside (clips, imports, synced data, Claude) safe to show. Allowlist based: only known-harmless
// tags and attributes survive; everything else is unwrapped or dropped. Applied every time stored HTML is displayed.
const SAFE_TAGS = new Set('p div span br hr b strong i em u s strike del ins sup sub a ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code table thead tbody tfoot tr td th caption col colgroup img audio font mark small dl dt dd figure figcaption section article header footer main aside abbr cite q kbd samp var time center address'.toUpperCase().split(' '));
const DROP_TAGS = 'script,style,iframe,object,embed,link,meta,form,base,svg,math,template,noscript,xmp,plaintext,textarea,select,option,input,button,frame,frameset,applet,title,head,video,source,track,canvas,dialog,slot,portal,picture';
const SAFE_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'style', 'colspan', 'rowspan', 'controls', 'align', 'face', 'color', 'start', 'type', 'contenteditable', 'data-att', 'data-fn', 'data-c', 'data-checked']);
const SAFE_CLASSES = new Set(['fn', 'att', 'nlink', 'todo', 'cmt', 'pagebreak', 'outline']);
const BAD_STYLE = ['position', 'z-index', 'top', 'left', 'right', 'bottom', 'inset', 'float', 'behavior', 'content', 'pointer-events', 'opacity', 'transform', 'filter', 'clip-path', 'mask', 'animation', 'transition', 'cursor', 'visibility', 'display'];
const urlScheme = v => String(v).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '').toLowerCase();
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  doc.body.querySelectorAll(DROP_TAGS).forEach(n => n.remove());
  for (const n of [...doc.body.querySelectorAll('*')]) {
    if (!n.isConnected) continue;
    if (!SAFE_TAGS.has(n.tagName) || n.namespaceURI !== 'http://www.w3.org/1999/xhtml') { n.replaceWith(...n.childNodes); continue; }
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase(), v = a.value;
      if (!SAFE_ATTRS.has(name)) { n.removeAttribute(a.name); continue; }
      if (name === 'href') { const u = urlScheme(v); if (!/^(https?:|mailto:|tel:|#)/.test(u)) n.removeAttribute(a.name); }
      else if (name === 'src') { const u = urlScheme(v); if (!(/^https?:/.test(u) || /^blob:/.test(u) || /^data:image\/(png|jpe?g|gif|webp);base64,/.test(u)) || n.tagName === 'AUDIO' && !/^blob:/.test(u)) n.removeAttribute(a.name); }
      else if (name === 'class') { const keep = v.split(/\s+/).filter(c => SAFE_CLASSES.has(c)); if (keep.length) n.setAttribute('class', keep.join(' ')); else n.removeAttribute('class'); }
      else if (name === 'contenteditable') { if (v !== 'false') n.removeAttribute(a.name); }
      else if (name === 'style') {
        if (/url\s*\(|expression|@import|javascript:|-moz-binding|\\/i.test(v)) { n.removeAttribute('style'); continue; }
        for (const prop of BAD_STYLE) n.style.removeProperty(prop);
        for (const prop of [...n.style]) if (BAD_STYLE.some(b => prop === b || prop.startsWith(b + '-'))) n.style.removeProperty(prop);
        if (!n.getAttribute('style')?.trim()) n.removeAttribute('style');
      }
    }
    if (n.tagName === 'A' && n.hasAttribute('href') && !n.getAttribute('href').startsWith('#')) n.setAttribute('rel', 'noopener noreferrer');
  }
  return doc.body.innerHTML;
}

// MD5 (needed to match Evernote attachments to their place in a note).
export function md5(bytes) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  const len = bytes.length, n = ((len + 8) >> 6) + 1, buf = new Uint8Array(n * 64);
  buf.set(bytes); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(n * 64 - 8, (len * 8) >>> 0, true); dv.setUint32(n * 64 - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < n * 64; o += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g; const r = i >> 4;
      if (r === 0) { F = (B & C) | (~B & D); g = i; }
      else if (r === 1) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (r === 2) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getUint32(o + g * 4, true)) >>> 0;
      A = D; D = C; C = B;
      const s = S[r * 4 + (i % 4)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return Array.from(new Uint8Array(out.buffer), b => b.toString(16).padStart(2, '0')).join('');
}
