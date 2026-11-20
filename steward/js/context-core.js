// Sorting context: one ordinary Steward note ("Sorting context — keywords", id `sorting-context`) where Charles keeps
// the names and words that tell the organizer where an entry belongs: customers, crew, suppliers, family, church
// people, courses, places. It lives in his Google Drive like every note (never in this public code), syncs to the
// phone and the Mac, and is edited like any note.
//
// Every new task or note is checked against it twice:
//  - on the device: each keyword line becomes a "word Steward knows" for the on-device organizer (organize-core);
//  - online: the whole note is handed to Claude Haiku with each entry to sort (js/ai.js).
//
// How the note is read (plain words, forgiving):
//   A heading names the area of the lines under it:  "CS Outdoors", "Seminary", "Church", "Home/Family", "Personal",
//   or "Customer promises" (phrases that mean he told a customer he would do something). Any other heading
//   ("Notes for Claude", "Not keywords") is guidance for Claude only; its lines are not keywords.
//   A heading or a line label may add "(project X)", "(notebook Y)" or "(tag a, b)".
//   A keyword line is "Label: word, word, word". The label itself is not a keyword. Words are split by commas or
//   semicolons. "Customers: Ashford, Brightwater, Nora Pell" → each of those means CS Outdoors.
// Kept free of browser APIs so it can be tested with plain Node.

export const CONTEXT_ID = 'sorting-context';
export const CONTEXT_TITLE = 'Sorting context — keywords';

const AREA_HEADS = [
  [/\bpromise/, 'promise'],
  [/\bcs outdoors\b|\bbusiness\b|\bwork\b|\blandscap/, 'cs-outdoors'],
  [/\bseminary\b|\bschool\b|\bbju\b/, 'seminary'],
  [/\bchurch\b|\bministry\b/, 'church'],
  [/\bhome\b|\bfamily\b/, 'home-family'],
  [/\bpersonal\b/, 'personal'],
];
const GUIDANCE = /\bnot keywords?\b|\bfor claude\b|\bhow (this|it) works\b|\bguidance\b|\bread me\b/;

const slug = s => String(s || '').trim().replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const list = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);

/** "(project CS Outdoors) (tag leaf-cleanup, mowing)" in a heading or label → { project, notebook, tags }. */
function options(s) {
  const o = { project: null, notebook: null, tags: [] };
  for (const m of String(s).matchAll(/\(\s*(project|notebook|tags?)\s*[:=]?\s*([^)]*)\)/gi)) {
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (!v) continue;
    if (k === 'project') o.project = v; else if (k === 'notebook') o.notebook = v; else o.tags.push(...list(v).map(slug).filter(Boolean));
  }
  return o;
}
const stripOptions = s => String(s).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

/** What a heading means: an area (or "promise"), a guidance section, or nothing new. */
function readHeading(text) {
  const low = stripOptions(text).toLowerCase();
  const opt = options(text);
  if (GUIDANCE.test(low)) return { area: null, guide: true, ...opt };
  for (const [re, area] of AREA_HEADS) if (re.test(low)) return { area, guide: false, ...opt };
  return { area: null, guide: true, ...opt };
}

/**
 * Read the context note's plain text. Returns { words: [{word, area, tags, promise, project, notebook}] }.
 * The same text gives the same words on every device.
 */
export function parseContext(text) {
  const words = [], seen = new Map();
  let sec = { area: null, guide: true, project: null, notebook: null, tags: [] };
  for (let raw of String(text || '').split(/\r?\n/)) {
    let line = raw.replace(/ /g, ' ').trim();
    if (!line) continue;
    const head = line.match(/^#{1,6}\s*(.+)$/);
    if (head) { sec = readHeading(head[1]); continue; }
    line = line.replace(/^([-*•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '');
    const c = line.indexOf(':');
    if (c < 1) {
      // A short line on its own that names an area works as a heading too ("CS Outdoors", "Home/Family").
      if (line.length <= 40 && !/[.,;!?]$/.test(line) && AREA_HEADS.some(([re]) => re.test(stripOptions(line).toLowerCase()))) sec = readHeading(line);
      continue;
    }
    if (sec.guide || !sec.area) continue;
    const label = line.slice(0, c), rest = line.slice(c + 1);
    if (/^https?$/i.test(label.trim())) continue;
    const opt = options(label);
    const promise = sec.area === 'promise';
    const area = promise ? 'cs-outdoors' : sec.area;
    const tags = [...new Set([...sec.tags, ...opt.tags])];
    const project = opt.project || sec.project || null, notebook = opt.notebook || sec.notebook || null;
    for (let w of list(rest)) {
      w = w.replace(/^["“'‘]+|["”'’.]+$/g, '').replace(/\s+/g, ' ').trim();
      if (w.length < 2 || w.length > 60) continue;
      const key = w.toLowerCase();
      const item = { word: w, area, tags, promise, project, notebook, from: 'context' };
      if (seen.has(key)) { // the same word twice: the first area wins, tags join
        const was = seen.get(key); was.tags = [...new Set([...was.tags, ...tags])]; was.promise = was.promise || promise;
        continue;
      }
      seen.set(key, item); words.push(item);
    }
  }
  return { words };
}

/** A note body (HTML) as plain lines, keeping headings as "# " lines so sections can be told apart. */
export function contextText(html) {
  return String(html || '')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n# ')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The note's text for Claude, trimmed to a size that keeps each sorting request quick and cheap. */
export const contextForClaude = (text, max = 6000) => {
  const t = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max) + '\n…' : t;
};
