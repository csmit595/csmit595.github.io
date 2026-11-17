// Turabian (notes-bibliography style, 9th ed.) citation formatting. Pure functions: source record in, HTML text out.
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clean = s => String(s ?? '').trim();

export const TYPES = {
  book: { label: 'Book', fields: ['authors', 'title', 'editors', 'translator', 'edition', 'volume', 'series', 'city', 'publisher', 'year', 'url'] },
  chapter: { label: 'Chapter or essay in a book', fields: ['authors', 'title', 'container', 'editors', 'edition', 'volume', 'city', 'publisher', 'year', 'pages'] },
  article: { label: 'Journal article', fields: ['authors', 'title', 'container', 'volume', 'issue', 'year', 'pages', 'doi', 'url'] },
  website: { label: 'Website or online article', fields: ['authors', 'title', 'container', 'date', 'accessed', 'url'] },
  thesis: { label: 'Thesis or dissertation', fields: ['authors', 'title', 'degree', 'publisher', 'year', 'url'] },
};
export const FIELD_LABELS = {
  authors: ['Author(s)', 'First Last; First Last'], title: ['Title', ''], container: ['Book, journal or site name', ''], editors: ['Editor(s)', 'First Last; First Last'],
  translator: ['Translator(s)', ''], edition: ['Edition', '2nd'], volume: ['Volume', ''], issue: ['Issue number', ''], series: ['Series', 'New International Commentary on the New Testament'],
  city: ['City of publication', 'Grand Rapids'], publisher: ['Publisher', 'Eerdmans'], year: ['Year', ''], pages: ['Page range', '45-67'], doi: ['DOI', '10.xxxx/xxxxx'],
  url: ['Web address', 'https://'], date: ['Date published', 'March 4, 2024'], accessed: ['Date accessed', 'November 17, 2026'], degree: ['Degree', 'PhD diss.'], short: ['Short title (optional)', 'Used in later footnotes'],
};
const LABEL_FOR = { chapter: { title: 'Chapter title', container: 'Book title', editors: 'Book editor(s)' }, article: { title: 'Article title', container: 'Journal' }, website: { title: 'Page title', container: 'Site name' }, thesis: { publisher: 'University' } };
export const fieldLabel = (type, f) => LABEL_FOR[type]?.[f] || FIELD_LABELS[f][0];

export function parseNames(str) {
  return clean(str).split(/\s*;\s*|\s+and\s+(?=[A-Z])/).map(clean).filter(Boolean).map(n => {
    if (/^\{.*\}$/.test(n)) return { last: n.slice(1, -1), first: '' };          // {Corporate Author}
    if (n.includes(',')) { const [l, ...f] = n.split(','); const rest = f.join(',').trim(); if (/^(jr|sr|ii|iii|iv)\.?$/i.test(rest)) return splitName(l + ' ' + rest); return { last: l.trim(), first: rest }; }
    return splitName(n);
  });
}
function splitName(n) {
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { last: parts[0], first: '' };
  let suffix = '';
  if (/^(jr|sr|ii|iii|iv)\.?$/i.test(parts[parts.length - 1])) suffix = ' ' + parts.pop();
  let i = parts.length - 1;
  while (i > 1 && /^(van|von|de|der|den|du|la|le|di|da|del|della|ten|ter)$/i.test(parts[i - 1])) i--;
  return { last: parts.slice(i).join(' ') + suffix, first: parts.slice(0, i).join(' ') };
}
const full = n => (n.first ? n.first + ' ' : '') + n.last;
const inverted = n => n.last + (n.first ? ', ' + n.first : '');
const list = a => a.length <= 1 ? a.join('') : a.length === 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
const noteNames = ns => ns.length > 3 ? full(ns[0]) + ' et al.' : list(ns.map(full));
const shortNames = ns => ns.length > 3 ? ns[0].last + ' et al.' : list(ns.map(n => n.last));
const bibNames = ns => ns.length === 0 ? '' : ns.length === 2 ? inverted(ns[0]) + ', and ' + full(ns[1]) : list([inverted(ns[0]), ...ns.slice(1, 10).map(full)]);
const dot = s => (/[.?!]["”’']?(<\/i>)?$/.test(s) ? s : s + '.');
const it = s => `<i>${esc(s)}</i>`;
const q = (s, punct) => { const t = esc(clean(s)); return /[?!]$/.test(t) ? `“${t}”` : `“${t}${punct}”`; };
function edition(e, cap) {
  e = clean(e); if (!e) return '';
  if (/^\d+$/.test(e)) { const n = +e, sfx = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; e = n + sfx; }
  if (!/ed\.?$|edition$/i.test(e)) e += ' ed.';
  e = e.replace(/edition$/i, 'ed.').replace(/ed$/i, 'ed.');
  return cap ? e[0].toUpperCase() + e.slice(1) : e[0].toLowerCase() + e.slice(1);
}
const pub = s => { const place = [clean(s.city), clean(s.publisher)].filter(Boolean).join(': '); return [place, clean(s.year) || 'n.d.'].filter(Boolean).join(', '); };
const link = s => clean(s.doi) ? 'https://doi.org/' + clean(s.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : clean(s.url);
export function shortTitle(s) {
  if (clean(s.short)) return clean(s.short);
  let t = clean(s.title).split(/[:?!]/)[0].trim();
  let w = t.split(/\s+/);
  if (w.length > 4 && /^(a|an|the)$/i.test(w[0])) w.shift();
  if (w.length > 5) { w = w.slice(0, 4); while (w.length > 1 && /^(of|the|to|and|for|in|on|a|an|with|from)$/i.test(w[w.length - 1])) w.pop(); }
  return w.join(' ').replace(/[,;]$/, '');
}
const inQuotes = t => t !== 'book';

/** First footnote for a source. `page` is the page being cited (optional). */
export function fullNote(s, page) {
  const a = parseNames(s.authors), eds = parseNames(s.editors), tr = parseNames(s.translator);
  const pg = clean(page), who = a.length ? noteNames(a) + ', ' : '';
  const edsAbbr = eds.length > 1 ? 'eds.' : 'ed.';
  let out;
  if (s.type === 'article') {
    out = `${who}${q(s.title, ',')} ${it(s.container)}${clean(s.volume) ? ' ' + esc(s.volume) : ''}${clean(s.issue) ? ', no. ' + esc(s.issue) : ''} (${esc(clean(s.year) || 'n.d.')})${pg ? ': ' + esc(pg) : ''}${link(s) ? ', ' + esc(link(s)) : ''}`;
  } else if (s.type === 'chapter') {
    out = `${who}${q(s.title, ',')} in ${it(s.container)}${eds.length ? ', ed. ' + esc(noteNames(eds)) : ''}${edition(s.edition) ? ', ' + esc(edition(s.edition)) : ''}${clean(s.volume) ? ', vol. ' + esc(s.volume) : ''} (${esc(pub(s))})${pg ? ', ' + esc(pg) : ''}`;
  } else if (s.type === 'website') {
    const when = clean(s.date) || (clean(s.accessed) ? 'accessed ' + clean(s.accessed) : '');
    const rest = [esc(clean(s.container)), esc(when), esc(clean(s.url))].filter(Boolean).join(', ');
    out = `${who}${q(s.title, rest ? ',' : '')}${rest ? ' ' + rest : ''}`;
  } else if (s.type === 'thesis') {
    out = `${who}${q(s.title, '')} (${esc([clean(s.degree) || 'PhD diss.', clean(s.publisher), clean(s.year)].filter(Boolean).join(', '))})${pg ? ', ' + esc(pg) : ''}${link(s) ? ', ' + esc(link(s)) : ''}`;
  } else {
    const lead = a.length ? esc(noteNames(a)) + ', ' : eds.length ? esc(noteNames(eds)) + `, ${edsAbbr}, ` : '';
    out = `${lead}${it(s.title)}${a.length && eds.length ? ', ed. ' + esc(noteNames(eds)) : ''}${tr.length ? ', trans. ' + esc(noteNames(tr)) : ''}${edition(s.edition) ? ', ' + esc(edition(s.edition)) : ''}${clean(s.volume) ? ', vol. ' + esc(s.volume) : ''}${clean(s.series) ? ', ' + esc(clean(s.series)) : ''} (${esc(pub(s))})${pg ? ', ' + esc(pg) : ''}${clean(s.url) ? ', ' + esc(clean(s.url)) : ''}`;
    return dot(out);
  }
  if (s.type !== 'book' && a.length) out = out.replace(who, esc(who));
  return dot(out);
}
/** Later footnotes for the same source. */
export function shortNote(s, page) {
  const a = parseNames(s.authors), eds = parseNames(s.editors), pg = clean(page);
  const who = a.length ? shortNames(a) : s.type === 'book' && eds.length ? shortNames(eds) : '';
  const t = inQuotes(s.type) ? (pg ? q(shortTitle(s), ',') : `“${esc(shortTitle(s))}”`) : it(shortTitle(s)) + (pg ? ',' : '');
  return dot([who ? esc(who) + ',' : '', t, esc(pg)].filter(Boolean).join(' '));
}
/** Bibliography entry. */
export function bibEntry(s) {
  const a = parseNames(s.authors), eds = parseNames(s.editors), tr = parseNames(s.translator);
  const who = a.length ? dot(esc(bibNames(a))) + ' ' : '';
  if (s.type === 'article') return dot(`${who}${q(s.title, '.')} ${it(s.container)}${clean(s.volume) ? ' ' + esc(s.volume) : ''}${clean(s.issue) ? ', no. ' + esc(s.issue) : ''} (${esc(clean(s.year) || 'n.d.')})${clean(s.pages) ? ': ' + esc(clean(s.pages).replace(/-/g, '–')) : ''}`) + (link(s) ? ' ' + dot(esc(link(s))) : '');
  if (s.type === 'chapter') return `${who}${q(s.title, '.')} In ${it(s.container)}${eds.length ? ', edited by ' + esc(noteNames(eds)) : ''}${clean(s.pages) ? ', ' + esc(clean(s.pages).replace(/-/g, '–')) : ''}. ${edition(s.edition) ? esc(edition(s.edition, true)) + ' ' : ''}${clean(s.volume) ? 'Vol. ' + esc(s.volume) + '. ' : ''}${dot(esc(pub(s)))}`;
  if (s.type === 'website') { const when = clean(s.date) || (clean(s.accessed) ? 'Accessed ' + clean(s.accessed) : ''); return [who.trim(), q(s.title, '.'), clean(s.container) ? dot(esc(clean(s.container))) : '', when ? dot(esc(when)) : '', clean(s.url) ? dot(esc(clean(s.url))) : ''].filter(Boolean).join(' '); }
  if (s.type === 'thesis') return `${who}${q(s.title, '.')} ${dot(esc([clean(s.degree) || 'PhD diss.', clean(s.publisher), clean(s.year)].filter(Boolean).join(', ')))}${link(s) ? ' ' + dot(esc(link(s))) : ''}`;
  const lead = a.length ? who : eds.length ? esc(bibNames(eds)) + `, ${eds.length > 1 ? 'eds.' : 'ed.'} ` : '';
  return `${lead}${dot(it(s.title))}${a.length && eds.length ? ' Edited by ' + dot(esc(noteNames(eds))) : ''}${tr.length ? ' Translated by ' + dot(esc(noteNames(tr))) : ''}${edition(s.edition) ? ' ' + esc(edition(s.edition, true)) : ''}${clean(s.volume) ? ' Vol. ' + esc(s.volume) + '.' : ''}${clean(s.series) ? ' ' + dot(esc(clean(s.series))) : ''} ${dot(esc(pub(s)))}${clean(s.url) ? ' ' + dot(esc(clean(s.url))) : ''}`;
}
/** Sort key for the bibliography: first author's (or editor's) last name, then title. */
export function sortKey(s) {
  const n = parseNames(s.authors)[0] || parseNames(s.editors)[0];
  return ((n ? n.last + ' ' + n.first : '') + ' ' + clean(s.title).replace(/^(a|an|the)\s+/i, '')).toLowerCase().trim();
}
export const sourceLabel = s => { const n = parseNames(s.authors)[0] || parseNames(s.editors)[0]; return `${n ? n.last + ', ' : ''}${shortTitle(s)}${clean(s.year) ? ' (' + clean(s.year) + ')' : ''}`; };
