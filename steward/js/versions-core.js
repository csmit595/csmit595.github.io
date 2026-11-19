// Note version history: the rules, with no browser APIs (tests/versions-core.test.mjs).
// A "snapshot" is a copy of a note's title and body (HTML) at one moment: { at, title, body, device, words, why }.
export const KEEP_RECENT = 20, KEEP_DAYS = 30;
const DAY = 864e5;
// Days are counted on Eastern standard time everywhere (phone, Mac, helper), so every device keeps the same snapshots.
export const dayKey = at => Math.floor((at - 5 * 3600e3) / DAY);
export const textOf = html => String(html || '').replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/blockquote)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
export const wordList = text => String(text || '').match(/\S+/g) || [];
export const words = text => wordList(text).length;
export const sameContent = (a, b) => !!a && !!b && (a.title || '') === (b.title || '') && (a.body || '') === (b.body || '');
/** Nothing worth keeping: no title, no words and no pictures or files in the body. */
export const isBlank = n => !String(n?.title || '').trim() && !textOf(n?.body) && !/<(img|audio|table|hr|a)\b/i.test(n?.body || '');

const order = (a, b) => a.at - b.at || String(a.device || '').localeCompare(String(b.device || ''));
/** Every snapshot from both lists, once each, oldest first. */
export function union(a = [], b = []) {
  const seen = new Map();
  for (const s of [...a, ...b]) if (s && s.at) seen.set(s.at + '|' + (s.device || ''), s);
  return [...seen.values()].sort(order);
}
/** Keep the newest 20, plus the last snapshot of each day for 30 days. */
export function prune(snaps, now = Date.now()) {
  const list = [...(snaps || [])].sort(order);
  const keep = new Set(list.slice(-KEEP_RECENT));
  const today = dayKey(now), lastOfDay = new Map();
  for (const s of list) { const d = dayKey(s.at); if (today - d < KEEP_DAYS) lastOfDay.set(d, s); }
  for (const s of lastOfDay.values()) keep.add(s);
  return list.filter(s => keep.has(s));
}
/** Add a snapshot unless the newest one already holds the same title and text. Returns the same list when nothing was added. */
export function addSnap(snaps, snap, now = Date.now()) {
  const list = snaps || [];
  if (isBlank(snap)) return list;
  const last = [...list].sort(order).pop();
  if (sameContent(last, snap)) return list;
  return prune([...list, snap], now);
}
/** A save that cuts the text to less than half: the old version is worth a copy right away. */
export function shrunk(oldHtml, newHtml) {
  const a = textOf(oldHtml).length, b = textOf(newHtml).length;
  return a >= 40 && b < a / 2;
}
/** Two versions of a body that differ in more than half of the old text (used before a sync replaces local text). */
export function veryDifferent(oldHtml, newHtml) {
  const a = textOf(oldHtml), b = textOf(newHtml);
  if (a === b || a.length < 40) return false;
  let p = 0; const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return a.length - p - s > a.length / 2;
}
/**
 * Word-by-word difference from `from` to `to`, as [{ t: 'same' | 'add' | 'del', s }]. Returns null when the texts are
 * too long to compare simply (the preview then shows the plain version).
 */
export function diffWords(from, to, limit = 2500) {
  const a = wordList(from), b = wordList(to);
  if (a.length > limit || b.length > limit) return null;
  // trim what the two share at each end, then a plain longest-common-subsequence table on the middle
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf), y = b.slice(pre, b.length - suf);
  if (x.length * y.length > 4e6) return null;
  const w = y.length + 1, T = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) T[i * w + j] = x[i] === y[j] ? T[(i + 1) * w + j + 1] + 1 : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
  const out = [], push = (t, s) => { const l = out[out.length - 1]; if (l && l.t === t) l.s += ' ' + s; else out.push({ t, s }); };
  for (let k = 0; k < pre; k++) push('same', a[k]);
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
    else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) push('del', x[i++]);
    else push('add', y[j++]);
  }
  while (i < x.length) push('del', x[i++]);
  while (j < y.length) push('add', y[j++]);
  for (let k = a.length - suf; k < a.length; k++) push('same', a[k]);
  return out;
}
/** Notes emptied from the trash wait here this long before they are removed for good. */
export const GONE_DAYS = 30;
export const goneExpired = (n, now = Date.now()) => !!n?.gone && now - n.gone > GONE_DAYS * DAY;
