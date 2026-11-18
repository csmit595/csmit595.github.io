// Organizer, the thinking part (no screens, no storage): suggests an area, finer tags, "customer promise", and a
// project or notebook for a new task or note, and learns from every suggestion Charles confirms or corrects.
//
// Three kinds of evidence are added together (as log-odds, so each can push a suggestion up or down):
//  1. Rules: words that plainly belong to an area ("mulch", "SCH 601", "Sunday school") and promise wording
//     ("told her we'd", "I'll have it done by Friday"). Personal names are not in this file (the code is public):
//     they are "words Steward knows", kept in his Google Drive and editable in Settings.
//  2. Learned word evidence: a small naive Bayes model trained on his confirmations ("lessons"). Lessons are synced
//     through Google Drive and every device trains the same model from them, so the phone and the Mac always agree.
//  3. Meaning: when the on-device language model is available, the closest past lessons in meaning vote too.
// Kept free of browser APIs so it can be tested with plain Node.

export const AREAS = [
  { id: 'cs-outdoors', name: 'CS Outdoors' },
  { id: 'seminary', name: 'Seminary' },
  { id: 'church', name: 'Church' },
  { id: 'home-family', name: 'Home/Family' },
  { id: 'personal', name: 'Personal' },
];
export const AREA_IDS = AREAS.map(a => a.id);
export const PROMISE = 'promise';

/** Finer tags that start out known, with the area each belongs to. Any tag he confirms is learned as well. */
export const DETAILS = {
  'cs-outdoors': ['mowing', 'leaf-cleanup', 'mulch', 'weed-treatment', 'trimming', 'aeration', 'sod', 'planting', 'hardscape', 'irrigation', 'drainage', 'tree-work', 'estimate', 'invoicing', 'materials', 'payroll', 'equipment'],
  seminary: ['sch-601', 'sth-692', 'sth-703', 'paper', 'exam', 'reading'],
  church: ['embrace-english', 'sunday-school', 'united-prayer', 'sermon'],
  'home-family': ['house-project', 'baby', 'family', 'date-night'],
  personal: ['devotions', 'health', 'finances', 'tithe'],
};
const DETAIL_AREA = Object.fromEntries(Object.entries(DETAILS).flatMap(([a, ts]) => ts.map(t => [t, a])));

const DISPLAY = { 'cs-outdoors': 'CS Outdoors', 'home-family': 'Home/Family', 'sch-601': 'SCH 601', 'sth-692': 'STh 692', 'sth-703': 'STh 703', promise: 'Customer promise', 'embrace-english': 'Embrace English', 'date-night': 'Date night', 'house-project': 'House project', 'sunday-school': 'Sunday School', 'united-prayer': 'United Prayer' };
/** How a tag reads on screen: "sch-601" → "SCH 601", "leaf-cleanup" → "Leaf cleanup". */
export const tagName = t => DISPLAY[t] || String(t).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
/** How a tag is stored: lower case, hyphens for spaces (the way Steward labels already work). */
export const tagSlug = s => String(s || '').trim().replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- rules: [pattern, area, tag or null, strength] ------------------------------------------------------------
const R = (re, area, tag, w) => ({ re, area, tag, w });
export const RULES = [
  // CS Outdoors
  R(/\bmow(s|ed|ing)?\b|\bmowers? route\b|\bedg(e|ed|ing)\b(?! of)/, 'cs-outdoors', 'mowing', 3),
  R(/\bleaf\b|\bleaves\b|\bleaf cleanup|\bblow(ing)? (off|out)\b/, 'cs-outdoors', 'leaf-cleanup', 3),
  R(/\bmulch|\bpine straw|\bpine needles\b/, 'cs-outdoors', 'mulch', 3.5),
  R(/\bweeds?\b|\bweed (control|treatment)|\bpre-?emergent|\bpost-?emergent|\bherbicide|\bspray(ed|ing)? (the|for|weeds)/, 'cs-outdoors', 'weed-treatment', 3),
  R(/\btrim(s|med|ming)?\b|\bhedges?\b|\bprun(e|ed|ing)\b|\bbush(es)?\b|\bshrubs?\b/, 'cs-outdoors', 'trimming', 2.5),
  R(/\baerat|\boverseed/, 'cs-outdoors', 'aeration', 3.5),
  R(/\bsod\b/, 'cs-outdoors', 'sod', 3.5),
  R(/\bseed(ed|ing)?\b|\bfertiliz|\blime\b|\bsoil test/, 'cs-outdoors', null, 2.5),
  R(/\bplant(s|ed|ing)?\b|\bboxwoods?\b|\bhollies\b|\bholly\b|\bgreen giants?\b|\barborvitae|\bcrape myrtle|\bazaleas?\b|\bcamellias?\b|\bhydrangeas?\b|\bannuals\b|\bperennials\b/, 'cs-outdoors', 'planting', 2.5),
  R(/\bpavers?\b|\bpatio\b|\bretaining wall|\briver rock|\bgravel\b|\bflagstone|\bstepping stones?|\bhardscap|\bpolymeric sand|\bbase rock/, 'cs-outdoors', 'hardscape', 3.5),
  R(/\birrigat|\bsprinklers?\b|\bdrip line|\bbackflow|\bspray heads?\b|\brotors?\b/, 'cs-outdoors', 'irrigation', 3.5),
  R(/\bfrench drain|\bdrainage\b|\bdownspouts?\b|\bgrading\b|\bstanding water|\bswale/, 'cs-outdoors', 'drainage', 3.5),
  R(/\btree (removal|work|trimming|install|planting)|\bstumps?\b|\bchainsaw|\blimbs?\b|\bstump grind/, 'cs-outdoors', 'tree-work', 3),
  R(/\bestimates?\b|\bquotes?\b(?! from (the )?(bible|book|scripture))|\bquoting\b|\bbids?\b|\bsite visit|\bmeasure(ments| the| it)\b|\bwalk ?through\b/, 'cs-outdoors', 'estimate', 2.5),
  R(/\binvoic|\bbilling\b|\bpast due\b|\bcollections?\b|\bdeposit\b|\bpayments?\b(?! on (the|my) (house|car|mortgage))/, 'cs-outdoors', 'invoicing', 2.5),
  R(/\bmaterials?\b|\btopsoil|\bfill dirt|\bsiteone|\bhome depot|\blowe'?s\b|\btractor supply|\bsupply house|\bbags? of\b|\byards? of\b|\bpallets? of\b/, 'cs-outdoors', 'materials', 2.5),
  R(/\bpayroll|\btime ?sheets?\b|\bpaychecks?\b|\bw-?2s?\b|\b1099s?\b|\bworkers'? comp/, 'cs-outdoors', 'payroll', 3.5),
  R(/\bmowers?\b|\btrailer\b|\bblowers?\b|\bweed ?eaters?\b|\btrimmers?\b|\bskid steer|\bequipment\b|\bsharpen|\bmower blades?\b|\bzero[- ]turn|\bedger\b/, 'cs-outdoors', 'equipment', 3),
  R(/\bcustomers?\b|\bclients?\b|\bjobber\b|\blmn\b|\bcrew\b|\blandscap|\blawns?\b|\bturf\b|\bproperty\b|\bproperties\b|\bjob ?site|\bhoa\b|\bcommercial account|\bmaintenance (route|contract|customers?)|\bcs outdoors\b|\bbusiness\b/, 'cs-outdoors', null, 2.5),
  R(/\byard\b|\bbeds?\b(?! ?room| ?time)/, 'cs-outdoors', null, 1.2),
  // Seminary
  R(/\bsch\.? ?601\b/, 'seminary', 'sch-601', 5),
  R(/\bsth\.? ?692\b/, 'seminary', 'sth-692', 5),
  R(/\bsth\.? ?703\b/, 'seminary', 'sth-703', 5),
  R(/\bseminary\b|\bbju\b|\bbob jones\b|\bsyllabus|\bprofessor|\blectures?\b|\bclass(es)?\b|\bhomework\b|\bassignments?\b|\bturabian|\bfootnotes?\b|\bbibliograph|\bthesis\b|\bcanvas\b|\bgrades?\b|\bsemester\b|\bcourse ?work\b|\bregistrar|\btuition\b/, 'seminary', null, 3),
  R(/\bpapers?\b|\bessays?\b|\bresearch paper|\breflection paper|\bbook review\b/, 'seminary', 'paper', 2),
  R(/\bexams?\b|\bquiz(zes)?\b|\bmidterms?\b|\bfinals?\b|\btests?\b(?! (the|for) (soil|ph))/, 'seminary', 'exam', 2),
  R(/\bread(ing)? (ch(apter)?s?|pages|pp\.?)\b|\bchapters? \d|\bpages? \d+|\breading (assignment|quiz|report)/, 'seminary', 'reading', 2.5),
  R(/\bhebrew\b|\bgreek\b|\bexegesis|\bexegetical|\bhermeneutic|\bsystematic theology|\btheolog|\bsoteriolog|\becclesiolog|\bchristolog|\bpneumatolog|\beschatolog|\bbibliology|\bchurch history\b/, 'seminary', null, 2.5),
  // Church
  R(/\bembrace english\b|\besl\b|\bembrace\b/, 'church', 'embrace-english', 4.5),
  R(/\bsunday school\b/, 'church', 'sunday-school', 4.5),
  R(/\bunited prayer\b|\bsermon ?audio\b/, 'church', 'united-prayer', 5),
  R(/\bsermons?\b|\bpreach/, 'church', 'sermon', 2.5),
  R(/\bchurch\b|\bpastors?\b|\bdeacons?\b|\bworship\b|\bministry\b|\boutreach\b|\bmissions?\b|\bmissionar|\bbible study\b|\bsmall group\b|\bprayer meeting\b|\bcongregation|\bfellowship\b|\bvbs\b|\bpotluck\b|\bchurch plant/, 'church', null, 3),
  // Home/Family
  R(/\bhouse\b|\bgarage\b|\bkitchen\b|\bbathroom\b|\bbedroom\b|\battic\b|\bbasement\b|\bcloset\b|\bpaint(ing)? the\b|\bplumber\b|\bhvac\b|\bfurnace\b|\bwater heater\b|\bappliances?\b|\bfurniture\b|\bshelves\b|\bshelf\b|\bgutters?\b/, 'home-family', 'house-project', 2),
  R(/\bhome\b/, 'home-family', null, 1.2),
  R(/\bbaby\b|\bcrib\b|\bcar seat\b|\bstroller\b|\bdiapers?\b|\bnewborn\b|\bmaternity\b|\bpediatrician|\bbaby shower\b|\bregistry\b|\bbirth plan\b|\blabor and delivery\b|\bob ?appointment\b|\bultrasound\b/, 'home-family', 'baby', 3.5),
  R(/\bdate night\b/, 'home-family', 'date-night', 4.5),
  R(/\bwife\b|\bmom\b|\bdad\b|\bmother\b|\bfather\b|\bbrothers?\b|\bsisters?\b|\bparents\b|\bin-laws?\b|\bgrandma\b|\bgrandpa\b|\bgrandparents\b|\bfamily\b|\bbirthday\b|\banniversary\b|\bthanksgiving\b|\bchristmas\b/, 'home-family', 'family', 2.5),
  R(/\bgrocer|\blaundry\b|\bdishes\b|\btrash day\b|\bchores?\b|\bdinner\b|\bcook(ing)?\b|\berrands?\b/, 'home-family', null, 1.5),
  // Personal
  R(/\bdevotions\b|\bquiet time\b|\bbible reading\b|\bread(ing)? (my )?bible\b|\bprayer time\b|\bscripture memory\b|\bmemoriz(e|ing) (scripture|verses?)|\bpray(ing)? through\b/, 'personal', 'devotions', 3.5),
  R(/\bdoctor\b|\bdentist\b|\bcheck ?up\b|\bgym\b|\bwork ?out\b|\bexercis|\bjog(ging)?\b|\blift(ing)? weights\b|\bhaircut\b|\bsleep\b|\bdiet\b|\bvitamins?\b|\bphysical\b|\beye exam\b|\bprescription\b/, 'personal', 'health', 3),
  R(/\btithe|\btithing\b|\bofferings?\b/, 'personal', 'tithe', 4.5),
  R(/\bbudget\b|\bsavings\b|\bbank\b|\bcredit card\b|\bloans?\b|\bpersonal tax|\binvest|\bretirement\b|\broth\b|\bira\b|\bmortgage\b|\bcar payment\b|\binsurance\b/, 'personal', 'finances', 2),
  R(/\bpersonal\b|\bjournal(ing)?\b|\bbook to read\b|\bhobby\b|\bmy own\b/, 'personal', null, 1.5),
];

// Promise wording: what he said he would do for someone, by when.
export const PROMISE_RULES = [
  [/\bpromis(e|ed|ing)\b/, 3.5],
  [/\btold (him|her|them|the customer|the client|[a-z]+) (i|we)('?d| would| will|'?ll)\b/, 4],
  [/\b(said|agreed|committed) (that )?(i|we)('?d| would| will|'?ll)\b/, 3.5],
  [/\b(i|we)('?ll| will) (be|come|get|have|send|call|text|email|stop|swing|bring|finish|start|do|install|put|drop|look|fix|replace|mow|trim|plant|lay|haul|clean|blow|spray|aerate|mulch|meet|follow|check|redo|touch|take|work)\b/, 3],
  [/\b(get back to|follow up with|circle back with|reach back out to)\b/, 2.5],
  [/\bsend (him|her|them|[a-z]+) (a |the |an |over )?(quote|estimate|invoice|bid|price|proposal|pictures?|photos?)/, 3],
  [/\b(owes?|owe) (him|her|them)\b|\bi owe\b/, 2],
  [/\bby (mon|tues|wednes|thurs|fri|satur|sun)day\b|\bby (tomorrow|tonight|next week|end of (the )?(day|week|month)|the \d+(st|nd|rd|th)?)\b|\bbefore (the weekend|thanksgiving|christmas)\b/, 1.2],
];

// ---- words ------------------------------------------------------------------------------------------------------
const STOP = new Set('a an and are as at be been but by for from has have he her him his i if in into is it its me my of on or our so than that the their them then there they this to up was we were what when where which who will with you your would could should can just about also get got need needs do did does not no yes ok one two'.split(' '));
const stem = w => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** The words of a text as a set (with neighbouring pairs, so "date night" is more than "date" and "night"). */
export function tokens(text) {
  const words = String(text || '').toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) || [];
  const out = new Set(); let prev = null;
  for (const w0 of words.slice(0, 400)) {
    if (STOP.has(w0) || (w0.length < 2 && !/\d/.test(w0))) { prev = null; continue; }
    const w = stem(w0);
    out.add(w);
    if (prev) out.add(prev + '_' + w);
    prev = w;
  }
  return out;
}
const norm = text => ' ' + String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ') + ' ';
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sig = x => 1 / (1 + Math.exp(-x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** The keys a lesson teaches: "a:<area>", "t:<tag>", "promise", "p:<project>", "n:<notebook>". */
export function lessonKeys(l) {
  const ks = new Set();
  if (l.area) ks.add('a:' + l.area);
  for (const t of l.tags || []) if (t && t !== PROMISE && !AREA_IDS.includes(t)) ks.add('t:' + t);
  if (l.promise) ks.add(PROMISE);
  if (l.project) ks.add('p:' + String(l.project).toLowerCase());
  if (l.notebook) ks.add('n:' + String(l.notebook).toLowerCase());
  return ks;
}

/**
 * Train from lessons (his confirmations; seeds count less). The same lessons give the same model on every device.
 * words: "words Steward knows" [{word, area, tags}]. projects/notebooks: names that exist, for "mentioned by name".
 */
export function train({ lessons = [], seeds = SEEDS, words = [], projects = [], notebooks = [] } = {}) {
  const m = { W: 0, df: new Map(), P: new Map(), dfP: new Map(), neg: new Map(), dfNeg: new Map(), tagArea: new Map(), n: 0, words: [], projects, notebooks, keys: new Set() };
  const add = (text, keys, rejected, w) => {
    const toks = tokens(text);
    m.W += w;
    for (const t of toks) m.df.set(t, (m.df.get(t) || 0) + w);
    for (const k of keys) {
      m.keys.add(k);
      m.P.set(k, (m.P.get(k) || 0) + w);
      let d = m.dfP.get(k); if (!d) m.dfP.set(k, d = new Map());
      for (const t of toks) d.set(t, (d.get(t) || 0) + w);
    }
    // A suggestion he took off counts as a firm "no" for that text.
    for (const k of rejected || []) {
      if (keys.has(k)) continue;
      m.keys.add(k);
      m.neg.set(k, (m.neg.get(k) || 0) + 1.5 * w);
      let d = m.dfNeg.get(k); if (!d) m.dfNeg.set(k, d = new Map());
      for (const t of toks) d.set(t, (d.get(t) || 0) + 1.5 * w);
    }
  };
  const tagVotes = new Map();
  for (const s of seeds) add(s.text, lessonKeys(s), null, 0.4);
  for (const l of lessons) {
    if (!l || l.deleted || !l.text) continue;
    const keys = lessonKeys(l);
    add(l.text, keys, l.rejected, 1); m.n++;
    if (l.area) for (const t of l.tags || []) { const v = tagVotes.get(t) || {}; v[l.area] = (v[l.area] || 0) + 1; tagVotes.set(t, v); }
  }
  for (const [t, v] of tagVotes) m.tagArea.set(t, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]);
  m.words = words.filter(w => w && !w.deleted && String(w.word || '').trim().length >= 2).map(w => ({ ...w, re: new RegExp(`(^|[^a-z0-9])${escRe(String(w.word).trim().toLowerCase())}($|[^a-z0-9])`) }));
  for (const w of m.words) { if (w.area) m.keys.add('a:' + w.area); for (const t of w.tags || []) { m.keys.add('t:' + t); if (w.area && !m.tagArea.has(t)) m.tagArea.set(t, w.area); } }
  return m;
}
/** Which area a tag belongs to, if known. */
export const areaOfTag = (m, t) => DETAIL_AREA[t] || m?.tagArea.get(t) || null;

/** How much the learned words say for (or against) a key, as log-odds, with no prior. */
function learned(m, k, toks) {
  const P = m.P.get(k) || 0;
  if (P < 0.35) return 0;
  const Q = Math.max(0.5, m.W - P + (m.neg.get(k) || 0));
  const dP = m.dfP.get(k), dN = m.dfNeg.get(k);
  let e = 0;
  for (const t of toks) {
    const d = m.df.get(t) || 0;
    if (!d) continue;
    const p1 = dP?.get(t) || 0, q1 = Math.max(0, d - p1) + (dN?.get(t) || 0);
    // a word seen only once or twice is weak evidence, however one-sided
    e += clamp(Math.log((p1 + 0.25) / (P + 0.5)) - Math.log((q1 + 0.25) / (Q + 0.5)), -2.5, 4.5) * (d / (d + 1));
  }
  // little data → trust it less
  return e * (P / (P + 0.5));
}

/**
 * Suggest organization for a text. near: optional [{keys:Set, sim}] — past lessons closest in meaning.
 * Returns { area, areaP, areas:[{id,p}], tags:[{id,p}], promise:{p}, project:{name,p}|null, notebook:{name,p}|null }.
 */
export function suggest(m, text, { near = [], kind = 'task' } = {}) {
  const low = norm(text), toks = tokens(text);
  const score = new Map(); // key -> log-odds
  const bump = (k, x) => score.set(k, (score.get(k) ?? -2.5) + x);
  const ruled = new Map();
  const rule = (k, x) => ruled.set(k, Math.min(5.5, (ruled.get(k) || 0) + x));
  if (!low.trim()) return empty();
  for (const r of RULES) if (r.re.test(low)) { rule('a:' + r.area, r.w); if (r.tag) rule('t:' + r.tag, r.w + 0.3); }
  for (const w of m.words) if (w.re.test(low)) { if (w.area) rule('a:' + w.area, 3.5); for (const t of w.tags || []) rule('t:' + t, 4); }
  let pr = 0;
  for (const [re, w] of PROMISE_RULES) if (re.test(low)) pr += w;
  if (pr > 1.5) rule(PROMISE, Math.min(5, pr)); // a deadline alone is not a promise
  // projects and notebooks mentioned by name
  for (const p of m.projects) { const n = String(p).trim(); if (n.length >= 3 && !/^inbox$/i.test(n) && new RegExp(`(^|[^a-z0-9])${escRe(n.toLowerCase())}($|[^a-z0-9])`).test(low)) rule('p:' + n.toLowerCase(), 4); }
  for (const nb of m.notebooks) { const n = String(nb).trim(); if (n.length >= 3 && !/^notes$/i.test(n) && new RegExp(`(^|[^a-z0-9])${escRe(n.toLowerCase())}($|[^a-z0-9])`).test(low)) rule('n:' + n.toLowerCase(), 3); }
  // a tag that is also a project's name ("hanel" for the Hanel project) points to that project
  for (const pj of m.projects) { const k = 't:' + tagSlug(pj); if (ruled.has(k)) rule('p:' + String(pj).toLowerCase(), ruled.get(k) - 0.5); }
  const keys = new Set([...m.keys, ...ruled.keys(), ...AREA_IDS.map(a => 'a:' + a), PROMISE]);
  for (const k of keys) { const x = (ruled.get(k) || 0) + learned(m, k, toks); if (x) bump(k, x); }
  // meaning: the closest past lessons vote
  const close = near.filter(n => n.sim >= 0.45);
  const tot = close.reduce((s, n) => s + n.sim, 0);
  if (close.length >= 2 && tot >= 0.9) {
    const vote = new Map();
    for (const n of close) for (const k of n.keys) vote.set(k, (vote.get(k) || 0) + n.sim);
    for (const [k, v] of vote) bump(k, 3.6 * (v / tot) - 1.2); // needs about a third of the close ones to agree
  }
  const p = k => sig(score.get(k) ?? -2.5);
  // area: the best one, helped by a strong tag that belongs to it
  const areas = AREA_IDS.map(id => {
    let s = score.get('a:' + id) ?? -2.5;
    for (const [k, v] of score) if (k.startsWith('t:') && areaOfTag(m, k.slice(2)) === id) s = Math.max(s, v - 0.4);
    return { id, s };
  }).sort((a, b) => b.s - a.s);
  // two areas both plausible: the runner-up takes some confidence away
  const top = areas[0], gap = top.s - (areas[1]?.s ?? -9);
  const areaP = sig(top.s - (gap < 1 ? 1 - gap : 0));
  const area = areaP >= 0.5 ? top.id : null;
  const tags = [...score.keys()].filter(k => k.startsWith('t:')).map(k => ({ id: k.slice(2), p: p(k) }))
    .filter(t => t.p >= 0.55 && (!area || !areaOfTag(m, t.id) || areaOfTag(m, t.id) === area || t.p >= 0.85))
    .sort((a, b) => b.p - a.p).slice(0, 4);
  let promiseP = p(PROMISE);
  if (area && area !== 'cs-outdoors' && areaP > 0.6) promiseP = sig(logit(promiseP) - 2); // the label is for customer promises
  const best = pre => { const c = [...score.keys()].filter(k => k.startsWith(pre)).map(k => ({ key: k.slice(2), p: p(k) })).sort((a, b) => b.p - a.p)[0]; return c && c.p >= 0.6 ? c : null; };
  const pj = kind === 'task' ? best('p:') : null, nb = kind === 'note' ? best('n:') : null;
  return {
    area, areaP, areas: areas.map(a => ({ id: a.id, p: sig(a.s) })), tags,
    promise: { p: promiseP, on: promiseP >= 0.55 },
    project: pj ? { name: pj.key, p: pj.p } : null, notebook: nb ? { name: nb.key, p: nb.p } : null,
  };
}
const logit = p => Math.log(p / (1 - p));
function empty() { return { area: null, areaP: 0, areas: [], tags: [], promise: { p: 0, on: false }, project: null, notebook: null }; }

/** Turn what was finally confirmed (and what was taken off) into a lesson to save and sync. */
export function makeLesson({ kind, text, area, tags, promise, project, notebook, suggested }) {
  const final = { area: area || null, tags: [...new Set((tags || []).filter(t => t && t !== PROMISE && !AREA_IDS.includes(t)))], promise: !!promise, project: project || null, notebook: notebook || null };
  const keys = lessonKeys(final), rejected = [];
  if (suggested) for (const k of lessonKeys(suggested)) if (!keys.has(k)) rejected.push(k);
  return { kind, text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600), ...final, rejected, at: Date.now() };
}

// ---- starter examples (generic; count less than his own confirmations) -------------------------------------------
const S = (text, area, tags = [], promise = false) => ({ text, area, tags, promise });
export const SEEDS = [
  S('Mow and edge the front and back lawn, blow off the drive', 'cs-outdoors', ['mowing']),
  S('Weekly mowing route Tuesday', 'cs-outdoors', ['mowing']),
  S('Leaf cleanup at the apartment complex, haul leaves to the dump', 'cs-outdoors', ['leaf-cleanup']),
  S('Put down 12 yards of brown mulch in the front beds', 'cs-outdoors', ['mulch', 'materials']),
  S('Pine straw for the strip mall beds', 'cs-outdoors', ['mulch']),
  S('Pre-emergent and weed control round two', 'cs-outdoors', ['weed-treatment']),
  S('Trim the hedges and prune the crape myrtles', 'cs-outdoors', ['trimming']),
  S('Aerate and overseed the back yard this fall', 'cs-outdoors', ['aeration']),
  S('Lay sod in the side yard where the dog wore it down', 'cs-outdoors', ['sod']),
  S('Plant three green giants and two boxwoods along the fence', 'cs-outdoors', ['planting']),
  S('Paver patio install, order base rock and polymeric sand', 'cs-outdoors', ['hardscape', 'materials']),
  S('Fix the broken sprinkler head in zone 3', 'cs-outdoors', ['irrigation']),
  S('French drain along the side of the house for standing water', 'cs-outdoors', ['drainage']),
  S('Stump grinding and tree removal in the back', 'cs-outdoors', ['tree-work']),
  S('Write up the estimate for the retaining wall and send the quote', 'cs-outdoors', ['estimate', 'hardscape']),
  S('Send invoices for last week and follow up on past due accounts', 'cs-outdoors', ['invoicing']),
  S('Pick up plants and topsoil from the nursery', 'cs-outdoors', ['materials', 'planting']),
  S('Run payroll and check the crew time sheets', 'cs-outdoors', ['payroll']),
  S('Sharpen mower blades and grease the trailer', 'cs-outdoors', ['equipment']),
  S('Move the customer recurring work over to LMN', 'cs-outdoors', []),
  S('Told her we would have the beds mulched by Friday', 'cs-outdoors', ['mulch'], true),
  S('Told him I would send the estimate tomorrow', 'cs-outdoors', ['estimate'], true),
  S('Promised the HOA we would finish the leaf cleanup before Thanksgiving', 'cs-outdoors', ['leaf-cleanup'], true),
  S('I will come back Thursday to replace the dead shrub', 'cs-outdoors', ['planting'], true),
  S('Said we would stop by and look at the drainage problem next week', 'cs-outdoors', ['drainage', 'estimate'], true),
  S('Get back to the client about the patio price', 'cs-outdoors', ['estimate', 'hardscape'], true),
  S('Read chapters 4 and 5 for SCH 601', 'seminary', ['sch-601', 'reading']),
  S('STh 692 reading quiz on Tuesday', 'seminary', ['sth-692', 'exam', 'reading']),
  S('STh 703 paper draft due, check Turabian footnotes', 'seminary', ['sth-703', 'paper']),
  S('Study for the midterm exam', 'seminary', ['exam']),
  S('Email the professor about the assignment', 'seminary', []),
  S('Seminary homework catch up', 'seminary', []),
  S('Prepare the lesson for Embrace English Wednesday night', 'church', ['embrace-english']),
  S('Print the ESL homework packet for my student', 'church', ['embrace-english']),
  S('Sunday School lesson prep', 'church', ['sunday-school']),
  S('Prep the United Prayer devotional for sermonaudio', 'church', ['united-prayer']),
  S('Sermon notes from Sunday morning', 'church', ['sermon']),
  S('Ask the pastor about the outreach plan', 'church', []),
  S('Fix the garage door and paint the hallway', 'home-family', ['house-project']),
  S('Assemble the crib and install the car seat', 'home-family', ['baby']),
  S('Plan date night Saturday', 'home-family', ['date-night']),
  S('Call my brother for his birthday', 'home-family', ['family']),
  S('Dinner with my parents and the in-laws', 'home-family', ['family']),
  S('Groceries and laundry', 'home-family', []),
  S('Morning devotions and Bible reading plan', 'personal', ['devotions']),
  S('Dentist appointment and annual checkup', 'personal', ['health']),
  S('Work out three times this week', 'personal', ['health']),
  S('Pay the tithe', 'personal', ['tithe']),
  S('Update the personal budget and savings goal', 'personal', ['finances']),
];
