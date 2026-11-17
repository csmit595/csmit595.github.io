// The clipper window: pick what to save, where, with which tags, then hand it to the background to save.
const $ = id => document.getElementById(id);
const P = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MODES = [
  { id: 'article', label: 'Article', icon: P('<path d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5"/>'), help: 'The main story with its pictures, without menus and ads.' },
  { id: 'text', label: 'Text only', icon: P('<path d="M5 6h14M5 10h14M5 14h14M5 18h9"/>'), help: 'The main story as plain, clean text with no pictures.' },
  { id: 'page', label: 'Full page', icon: P('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"/>'), help: 'Everything on the page, menus and all.' },
  { id: 'selection', label: 'Selection', icon: P('<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M9 10h6M9 14h4"/>'), help: 'Only the part you highlighted.' },
  { id: 'bookmark', label: 'Bookmark', icon: P('<path d="M6 3h12v18l-6-4-6 4z"/>'), help: 'The link, its title, a short summary and its picture.' },
  { id: 'shot', label: 'Screen', icon: P('<path d="M3 5h18v12H3zM8 21h8M12 17v4"/>'), help: 'A picture of what you can see in this tab right now.' },
  { id: 'area', label: 'Area', icon: P('<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z"/>'), help: 'This window closes; drag a box over the part of the page to save.' },
  { id: 'pdf', label: 'PDF', icon: P('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h1.5a1.5 1.5 0 0 1 0 3H8v-4zM8 16v2"/>'), help: 'Saves the PDF file itself. Steward reads it so search finds its words.' },
];
let tab, info = {}, mode = 'article', titleTouched = false, previews = {}, tags = [], meta = {}, savedNote = null, previewSeq = 0;
const canScript = url => /^(https?|file):/.test(url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url);
const send = msg => chrome.runtime.sendMessage(msg);
const norm = u => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname).replace(/\/$/, '') + x.search; } catch { return u; } };
const status = (t, err) => { $('status').textContent = t || ''; $('status').className = 'status' + (err ? ' err' : ''); };

function drawModes() {
  const ok = id => {
    if (!canScript(tab.url)) return id === 'bookmark' && /^https?:/.test(tab.url || '');
    if (id === 'selection') return info.hasSelection;
    if (id === 'pdf') return info.isPdf;
    if (info.isPdf) return ['pdf', 'bookmark', 'shot', 'area'].includes(id);
    return true;
  };
  $('modes').replaceChildren(...MODES.map(m => {
    const b = document.createElement('button');
    b.type = 'button'; b.innerHTML = m.icon + `<span>${m.label}</span>`; b.title = m.help; b.setAttribute('role', 'radio');
    b.disabled = !ok(m.id); b.className = m.id === mode ? 'on' : ''; b.setAttribute('aria-checked', String(m.id === mode));
    b.onclick = () => { mode = m.id; drawModes(); preview(); };
    return b;
  }));
}

async function preview() {
  const m = MODES.find(x => x.id === mode), box = $('preview'), seq = ++previewSeq;
  const show = (head, body) => { box.innerHTML = ''; const b = document.createElement('b'); b.textContent = head; box.append(b); if (body) box.append(document.createTextNode(body)); };
  if (!['article', 'text', 'page', 'selection'].includes(mode)) {
    show(m.label, m.help + (mode === 'bookmark' && info.description ? ' — ' + info.description.slice(0, 140) : ''));
    if (!titleTouched) $('title').value = mode === 'shot' || mode === 'area' ? 'Screenshot: ' + (info.title || tab.title || '') : info.title || tab.title || '';
    return;
  }
  show(m.label, 'Reading the page…');
  try {
    const p = previews[mode] || (previews[mode] = await send({ type: 'preview', tabId: tab.id, mode }));
    if (seq !== previewSeq) return;
    if (p.error || p.ok === false) { show(m.label, p.error || 'This page could not be read.'); return; }
    const pics = p.images?.length || 0;
    show(`${m.label} · ${(p.words || 0).toLocaleString()} words${mode === 'text' ? '' : ` · ${pics} picture${pics === 1 ? '' : 's'}`}`, p.snippet ? p.snippet + (p.snippet.length >= 280 ? '…' : '') : '');
    if (!titleTouched && mode !== 'selection') $('title').value = p.title || info.title || '';
  } catch (e) { if (seq === previewSeq) show(m.label, 'This page could not be read: ' + e.message); }
}

function drawTags() {
  const box = $('tags'), input = $('tag');
  box.querySelectorAll('.chip').forEach(c => c.remove());
  for (const t of tags) {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = t;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove ' + t;
    x.onclick = () => { tags = tags.filter(y => y !== t); drawTags(); };
    c.append(x); box.insertBefore(c, input);
  }
}
function addTag() {
  const input = $('tag');
  for (const t of input.value.split(',').map(s => s.trim()).filter(Boolean)) if (!tags.some(x => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  input.value = ''; drawTags();
}

function clippedBefore() {
  const here = norm(tab.url), hit = (meta.clipped || []).find(([u]) => norm(u) === here);
  const el = $('before');
  if (!hit) { el.hidden = true; return; }
  el.hidden = false; el.textContent = 'You already saved this page: ';
  const a = document.createElement('a'); a.textContent = hit[2] || 'open the note';
  a.onclick = () => { send({ type: 'open', noteId: hit[1] }); window.close(); };
  el.append(a);
}

async function save() {
  addTag();
  const btn = $('save'); btn.disabled = true;
  const opts = { tabId: tab.id, mode, notebook: $('notebook').value.trim() || 'Clips', tags, remark: $('remark').value, title: $('title').value.trim() };
  const p = previews[mode];
  if (p && !p.error && ['article', 'text', 'page', 'selection'].includes(mode)) opts.page = p;
  chrome.storage.local.set({ lastNotebook: opts.notebook });
  if (mode === 'area') { send({ type: 'clip', opts }); window.close(); return; }
  status(mode === 'pdf' ? 'Saving the PDF…' : 'Saving' + (p?.images?.length ? ' the page and its pictures…' : '…'));
  try {
    const res = await send({ type: 'clip', opts });
    if (res.ok) {
      savedNote = res.noteId;
      $('doneMsg').textContent = `Saved to ${res.notebook || opts.notebook}.`;
      $('form').hidden = true; $('done').hidden = false;
      setTimeout(() => window.close(), 6000);
    } else if (res.queued) {
      status('Saved in the clipper. It goes into Steward as soon as Steward finishes opening — you can close this.', false);
      btn.disabled = false;
    } else if (!res.cancelled) { status(res.error || 'That did not save. Try again.', true); btn.disabled = false; }
  } catch (e) { status(e.message, true); btn.disabled = false; }
}

async function start() {
  const forced = new URLSearchParams(location.search).get('tab'); // lets the clipper be opened for a given tab
  tab = forced ? await chrome.tabs.get(+forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const st = await chrome.storage.local.get(['meta', 'lastNotebook', 'queue']);
  meta = st.meta || {};
  $('notebook').value = st.lastNotebook || 'Clips';
  $('nbs').replaceChildren(...[...new Set(['Clips', ...(meta.notebooks || [])])].map(n => Object.assign(document.createElement('option'), { value: n })));
  $('tagl').replaceChildren(...(meta.tags || []).map(n => Object.assign(document.createElement('option'), { value: n })));
  if (st.queue?.length) status(`${st.queue.length} clip${st.queue.length === 1 ? ' is' : 's are'} waiting for Steward to open.`);
  $('title').value = tab.title || '';
  if (canScript(tab.url)) {
    try { info = await send({ type: 'preview', tabId: tab.id, mode: 'info' }); } catch { info = {}; }
    if (info.ok === false) info = { isPdf: /\.pdf($|[?#])/i.test(tab.url) };
  } else info = { title: tab.title, url: tab.url };
  if (!info.title) info.title = tab.title;
  mode = info.isPdf ? 'pdf' : info.hasSelection ? 'selection' : canScript(tab.url) ? 'article' : 'bookmark';
  if (!/^(https?|file):/.test(tab.url || '')) { $('save').disabled = true; status('Chrome does not let extensions save its own pages. Open a website and try again.', true); }
  drawModes(); preview(); clippedBefore();
}

$('title').addEventListener('input', () => { titleTouched = true; });
$('tag').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (e.target.value.trim()) addTag(); else if (e.key === 'Enter') save(); }
  if (e.key === 'Backspace' && !e.target.value && tags.length) { tags.pop(); drawTags(); }
});
$('tag').addEventListener('change', () => { if (meta.tags?.includes($('tag').value)) addTag(); });
$('title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
$('save').onclick = save;
$('open').onclick = () => { send({ type: 'open' }); window.close(); };
$('openNote').onclick = () => { send({ type: 'open', noteId: savedNote }); window.close(); };
$('close').onclick = () => window.close();
start();
