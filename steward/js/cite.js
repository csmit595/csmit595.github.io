// Citation formatting for BJU Seminary papers: Turabian 9th ed. notes-bibliography style,
// with the Seminary's Style Manual for Turabian Papers (updated 2024) taking precedence where it differs.
// Pure functions: source record in, HTML text out.
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clean = s => String(s ?? '').trim();
const dash = s => clean(s).replace(/(\d)\s*-\s*(\d)/g, '$1–$2'); // en dash between page numbers

export const TYPES = {
  book: { label: 'Book', fields: ['authors', 'title', 'editors', 'translator', 'edition', 'volume', 'setTitle', 'series', 'seriesAbbr', 'origYear', 'city', 'publisher', 'year'] },
  chapter: { label: 'Chapter or article in an edited book', fields: ['authors', 'title', 'container', 'containerAbbr', 'editors', 'edition', 'volume', 'city', 'publisher', 'year', 'pages'] },
  article: { label: 'Journal article', fields: ['authors', 'title', 'container', 'containerAbbr', 'volume', 'issue', 'year', 'pages', 'url'] },
  reference: { label: 'Article in a dictionary or reference work', fields: ['authors', 'title', 'container', 'containerAbbr', 'editors', 'volume', 'volumes', 'city', 'publisher', 'year'] },
  review: { label: 'Book review', fields: ['authors', 'title', 'reviewedAuthor', 'container', 'containerAbbr', 'volume', 'issue', 'year', 'pages'] },
  website: { label: 'Online article', fields: ['authors', 'title', 'accessed', 'url'] },
  thesis: { label: 'Thesis or dissertation', fields: ['authors', 'title', 'degree', 'publisher', 'year'] },
};
export const FIELD_LABELS = {
  authors: ['Author(s)', 'First M. Last; First Last'], title: ['Title', ''], container: ['Book, journal or site name', ''], containerAbbr: ['Its abbreviation, used in footnotes (optional)', 'JETS'],
  editors: ['Editor(s)', 'First Last; First Last'], translator: ['Translator(s)', ''], edition: ['Edition', '2nd'], volume: ['Volume number', ''], volumes: ['Number of volumes in the whole work', '5'],
  setTitle: ['Title of the whole multivolume work (if this volume has its own title)', 'Old Testament Theology'], issue: ['Issue number', ''],
  series: ['Series, written out', 'The New American Commentary'], seriesAbbr: ['Series abbreviation, used in footnotes', 'NAC'], origYear: ['Original year, if this is a reprint', '1874'],
  city: ['City of publication', 'Grand Rapids'], publisher: ['Publisher, shortened', 'Eerdmans'], year: ['Year', ''], pages: ['Page range of the whole piece', '265-91'],
  url: ['Web address (leave empty if it matches the print version)', 'https://'], accessed: ['Date accessed', 'November 17, 2026'], degree: ['Degree', 'PhD diss.'], reviewedAuthor: ['Author of the book reviewed', ''],
  short: ['Short title for later footnotes (optional)', ''],
};
const LABEL_FOR = {
  chapter: { title: 'Chapter or article title', container: 'Book title', editors: 'Book editor(s)', volume: 'Volume number (multivolume works)' }, article: { title: 'Article title', container: 'Journal' },
  reference: { title: 'Entry (the word or topic)', container: 'Reference work title', editors: 'Editor(s) of the work', volume: 'Volume cited' }, review: { authors: 'Reviewer', title: 'Title of the book reviewed', container: 'Journal' },
  website: { title: 'Article title' }, thesis: { publisher: 'University' },
};
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
  if (i === 1 && /^(van|von|de|du|la|le|di|da|del|della|ten|ter)$/i.test(parts[0]) && parts.length === 2) i = 0; // "von Rad" alone
  return { last: parts.slice(i).join(' ') + suffix, first: parts.slice(0, i).join(' ') };
}
const full = n => (n.first ? n.first + ' ' : '') + n.last;
const inverted = n => n.last + (n.first ? ', ' + n.first : '');
const list = a => a.length <= 1 ? a.join('') : a.length === 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
const noteNames = ns => ns.length > 3 ? full(ns[0]) + ', et al.' : list(ns.map(full));           // BJU: "Bruce C. Birch, et al."
const shortNames = ns => ns.length > 3 ? ns[0].last + ' et al.' : list(ns.map(n => n.last));
const bibNames = ns => ns.length === 0 ? '' : ns.length > 3 ? inverted(ns[0]) + ', et al.' : ns.length === 2 ? inverted(ns[0]) + ', and ' + full(ns[1]) : list([inverted(ns[0]), ...ns.slice(1).map(full)]);
const dot = s => (/[.?!]["”’']?(<\/i>)?$/.test(s) ? s : s + '.');
const it = s => `<i>${esc(clean(s))}</i>`;
const q = (s, punct) => { const t = esc(clean(s)); return /[?!]$/.test(t) ? `“${t}”` : `“${t}${punct}”`; };
function edition(e, cap) {
  e = clean(e); if (!e) return '';
  if (/^\d+$/.test(e)) { const n = +e, sfx = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; e = n + sfx; }
  if (!/ed\.?$|edition$/i.test(e)) e += ' ed.';
  e = e.replace(/edition$/i, 'ed.').replace(/ed$/i, 'ed.');
  return cap ? e[0].toUpperCase() + e.slice(1) : e[0].toLowerCase() + e.slice(1);
}
const pub = s => { const place = [clean(s.city), clean(s.publisher)].filter(Boolean).join(': ') || 'n.p.'; return (clean(s.origYear) ? clean(s.origYear) + '; reprint, ' : '') + [place, clean(s.year) || 'n.d.'].join(', '); };
const abbrOr = s => it(clean(s.containerAbbr) || s.container);
export function shortTitle(s) {
  if (clean(s.short)) return clean(s.short);
  const t = clean(s.title).split(/[:?!]/)[0].trim();
  let w = t.split(/\s+/);
  if (w.length > 4 && /^(a|an|the)$/i.test(w[0])) w.shift();
  if (w.length > 5) { w = w.slice(0, 4); while (w.length > 1 && /^(of|the|to|and|for|in|on|a|an|with|from)$/i.test(w[w.length - 1])) w.pop(); }
  return w.join(' ').replace(/[,;]$/, '');
}

/** First footnote for a source. `page` is the page being cited (optional). */
export function fullNote(s, page) {
  const a = parseNames(s.authors), eds = parseNames(s.editors), tr = parseNames(s.translator);
  const pg = esc(dash(page)), who = a.length ? esc(noteNames(a)) + ', ' : '', vol = esc(clean(s.volume));
  const loc = vol && pg ? `, ${vol}:${pg}` : pg ? ', ' + pg : '';
  const jr = `${vol ? ' ' + vol : ''}${clean(s.issue) ? ', no. ' + esc(clean(s.issue)) : ''} (${esc(clean(s.year) || 'n.d.')})${pg ? ': ' + pg : ''}`;
  let out;
  if (s.type === 'article') out = `${who}${q(s.title, ',')} ${it(s.container)}${jr}${clean(s.url) ? ', ' + esc(clean(s.url)) : ''}`;
  else if (s.type === 'review') out = `${who}review of ${it(s.title)}${clean(s.reviewedAuthor) ? ', by ' + esc(noteNames(parseNames(s.reviewedAuthor))) : ''}, in ${abbrOr(s)}${jr}`;
  else if (s.type === 'chapter') out = `${who}${q(s.title, ',')} in ${abbrOr(s)}${eds.length ? ', ed. ' + esc(noteNames(eds)) : ''}${!clean(s.containerAbbr) && edition(s.edition) ? ', ' + esc(edition(s.edition)) : ''} (${esc(pub(s))})${loc}`;
  else if (s.type === 'reference') out = `${who}${q(s.title, ',')} ${abbrOr(s)}${eds.length ? ', ed. ' + esc(noteNames(eds)) : ''} (${esc(pub(s))})${loc}`;
  else if (s.type === 'website') out = `${who.replace(/, $/, '')}${who ? ', ' : ''}${q(s.title, '')}${clean(s.accessed) ? '; accessed ' + esc(clean(s.accessed)) : ''}${clean(s.url) ? ', ' + esc(clean(s.url)) : ''}`;
  else if (s.type === 'thesis') out = `${who}${q(s.title, '')} (${esc([clean(s.degree) || 'PhD diss.', clean(s.publisher), clean(s.year)].filter(Boolean).join(', '))})${pg ? ', ' + pg : ''}`;
  else {
    const lead = a.length ? who : eds.length ? esc(noteNames(eds)) + `, ${eds.length > 1 ? 'eds.' : 'ed.'}, ` : '';
    const set = clean(s.setTitle);
    out = `${lead}${it(s.title)}${set && vol ? `, vol. ${vol} of ${it(set)}` : ''}${a.length && eds.length ? ', ed. ' + esc(noteNames(eds)) : ''}${tr.length ? ', trans. ' + esc(noteNames(tr)) : ''}${edition(s.edition) ? ', ' + esc(edition(s.edition)) : ''}${!set && vol ? ', vol. ' + vol : ''}${clean(s.seriesAbbr) || clean(s.series) ? ', ' + esc(clean(s.seriesAbbr) || clean(s.series)) : ''} (${esc(pub(s))})${pg ? ', ' + pg : ''}`;
  }
  return dot(out);
}
/** Later footnotes for the same source: last name, short title, page. */
export function shortNote(s, page) {
  const a = parseNames(s.authors), eds = parseNames(s.editors), pg = esc(dash(page)), vol = esc(clean(s.volume));
  const who = a.length ? shortNames(a) : s.type === 'book' && eds.length ? shortNames(eds) : '';
  const where = pg && vol && (s.type === 'chapter' || s.type === 'reference') ? `${vol}:${pg}` : pg;
  const t = s.type === 'book' ? it(shortTitle(s)) + (where ? ',' : '') : s.type === 'review' ? 'review of ' + it(shortTitle(s)) + (where ? ',' : '') : (where ? q(shortTitle(s), ',') : `“${esc(shortTitle(s))}”`);
  return dot([who ? esc(who) + ',' : '', t, where].filter(Boolean).join(' '));
}
/** Bibliography entry. With `repeat`, the author is replaced by three em dashes (same author as the entry above). */
export function bibEntry(s, repeat) {
  const a = parseNames(s.authors), eds = parseNames(s.editors), tr = parseNames(s.translator), vol = esc(clean(s.volume));
  const name = ns => repeat ? '———' : esc(bibNames(ns));
  const who = a.length ? dot(name(a)) + ' ' : '';
  const jr = `${vol ? ' ' + vol : ''}${clean(s.issue) ? ', no. ' + esc(clean(s.issue)) : ''} (${esc(clean(s.year) || 'n.d.')})${clean(s.pages) ? ': ' + esc(dash(s.pages)) : ''}`;
  if (s.type === 'article') return dot(`${who}${q(s.title, '.')} ${it(s.container)}${jr}`) + (clean(s.url) ? ' ' + dot(esc(clean(s.url))) : '');
  if (s.type === 'review') return dot(`${who}Review of ${it(s.title)}${clean(s.reviewedAuthor) ? ', by ' + esc(noteNames(parseNames(s.reviewedAuthor))) : ''}. ${abbrOr(s)}${jr}`);
  if (s.type === 'chapter') return `${who}${q(s.title, '.')} In ${it(s.container)}${edition(s.edition) ? ', ' + esc(edition(s.edition)) : ''}${eds.length ? ', edited by ' + esc(noteNames(eds)) : ''}${clean(s.pages) ? ', ' + (vol ? vol + ':' : '') + esc(dash(s.pages)) : ''}. ${dot(esc(pub(s)))}`;
  if (s.type === 'reference') return `${eds.length ? name(eds) + `, ${eds.length > 1 ? 'eds.' : 'ed.'} ` : ''}${dot(it(s.container))}${clean(s.volumes) ? ' ' + esc(clean(s.volumes)) + ' vols.' : ''} ${dot(esc(pub(s)))}`;
  if (s.type === 'website') return [who.trim(), q(s.title, '.'), clean(s.accessed) ? dot('Accessed ' + esc(clean(s.accessed))) : '', clean(s.url) ? dot(esc(clean(s.url))) : ''].filter(Boolean).join(' ');
  if (s.type === 'thesis') return `${who}${q(s.title, '.')} ${dot(esc([clean(s.degree) || 'PhD diss.', clean(s.publisher), clean(s.year)].filter(Boolean).join(', ')))}`;
  const lead = a.length ? who : eds.length ? name(eds) + `, ${eds.length > 1 ? 'eds.' : 'ed.'} ` : '';
  const set = clean(s.setTitle);
  return `${lead}${dot(it(s.title))}${set && vol ? ` Vol. ${vol} of ${dot(it(set))}` : ''}${a.length && eds.length ? ' Edited by ' + dot(esc(noteNames(eds))) : ''}${tr.length ? ' Translated by ' + dot(esc(noteNames(tr))) : ''}${edition(s.edition) ? ' ' + esc(edition(s.edition, true)) : ''}${!set && vol ? ' Vol. ' + vol + '.' : ''}${clean(s.series) ? ' ' + dot(esc(clean(s.series))) : ''} ${dot(esc(pub(s)))}`;
}
/** Who an entry is alphabetized under (authors; editors for edited books and reference works). */
export function bibOwner(s) { const ns = s.type === 'reference' ? parseNames(s.editors) : parseNames(s.authors).length ? parseNames(s.authors) : s.type === 'book' ? parseNames(s.editors) : []; return ns.map(n => (n.last + ' ' + n.first).toLowerCase()).join('; '); }
/** Sort key: owner's last name, then title with any leading article ignored. */
export function sortKey(s) { return (bibOwner(s) + '  ' + clean(s.type === 'reference' ? s.container : s.title).replace(/^(a|an|the)\s+/i, '')).toLowerCase().trim(); }
/** The whole bibliography, alphabetized, with three em dashes for a repeated author. */
export function bibliography(sources) {
  const sorted = [...sources].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return sorted.map((s, i) => { const o = bibOwner(s); return bibEntry(s, i > 0 && !!o && o === bibOwner(sorted[i - 1])); });
}
export const sourceLabel = s => { const n = parseNames(s.authors)[0] || parseNames(s.editors)[0]; return `${n ? n.last + ', ' : ''}${shortTitle(s)}${clean(s.year) ? ' (' + clean(s.year) + ')' : ''}`; };
