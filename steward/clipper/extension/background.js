// Steward Clipper background: makes clips, keeps copies of pictures and files, and hands them to an open Steward tab.
// Clips wait in a queue (chrome.storage) until Steward has saved them, so nothing is lost if Steward is closed.
const STEWARD = 'https://csmit595.github.io/steward/';
const STEWARD_MATCH = STEWARD + '*';
const MAX_PIC = 15e6, MAX_FILE = 60e6;

const waiters = new Map();      // clip id -> resolve(result) for whoever asked for the clip
const openedByUs = new Set();   // Steward tabs this extension opened (closed again once the queue is empty)

// ---------- small helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const set = (k, v) => chrome.storage.local.set({ [k]: v });
async function toDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}
const fileName = (url, fallback) => {
  try { const n = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); return n.replace(/[^\w.() -]+/g, '-').slice(0, 80) || fallback; } catch { return fallback; }
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function badge(text, color, ms = 4000) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (ms) setTimeout(() => chrome.action.setBadgeText({ text: '' }), ms);
}
const canScript = url => /^(https?|file):/.test(url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url);

// ---------- reading the page ----------
async function extract(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/Readability.js', 'extract.js'] });
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: m => globalThis.__stewardExtract(m), args: [mode] });
  if (!result) throw new Error('The page could not be read.');
  return result;
}

async function fetchBlob(url, max) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status}`);
  const b = await res.blob();
  if (b.size > max) throw new Error('too big');
  return b;
}

/** Copies of the pictures in a clip, a few at a time. Pictures that can't be fetched stay as links. */
async function grabPictures(urls) {
  const out = [], list = [...new Set(urls)].slice(0, 80);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const src = list[i++];
      try {
        const b = await fetchBlob(src, MAX_PIC);
        if (!/^image\//.test(b.type) || (b.size < 700 && !/^data:/.test(src))) continue;
        out.push({ src, data: await toDataUrl(b) });
      } catch { /* left as a link */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// ---------- screenshots ----------
/** Runs in the page: lets the person drag a box, resolves with it (CSS pixels) or null if they press Esc. */
function pickArea() {
  return new Promise(resolve => {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(20,64,28,.18)';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid #14401c;background:rgba(255,255,255,.12);box-shadow:0 0 0 100vmax rgba(0,0,0,.25);display:none';
    const tip = document.createElement('div');
    tip.textContent = 'Drag to choose what to save · Esc to cancel';
    tip.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#14401c;color:#fcfaf3;font:600 14px -apple-system,system-ui,sans-serif;padding:8px 14px;border-radius:8px';
    o.append(box, tip); document.documentElement.append(o);
    let x0, y0, r = null;
    const done = v => { removeEventListener('keydown', key, true); o.remove(); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(v), 60))); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    addEventListener('keydown', key, true);
    o.addEventListener('mousedown', e => { x0 = e.clientX; y0 = e.clientY; box.style.display = 'block'; tip.style.display = 'none'; o.style.background = 'transparent'; e.preventDefault(); });
    o.addEventListener('mousemove', e => {
      if (x0 === undefined) return;
      r = { x: Math.min(x0, e.clientX), y: Math.min(y0, e.clientY), w: Math.abs(e.clientX - x0), h: Math.abs(e.clientY - y0) };
      Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    });
    o.addEventListener('mouseup', () => done(r && r.w > 8 && r.h > 8 ? { ...r, dpr: devicePixelRatio } : null));
  });
}

async function screenshot(tab, area) {
  let rect = null;
  if (area) {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pickArea });
    if (!result) return null; // cancelled
    rect = result;
  }
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (!rect) return shot;
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const k = rect.dpr || 1;
  const sx = Math.round(rect.x * k), sy = Math.round(rect.y * k);
  const w = Math.min(Math.round(rect.w * k), bmp.width - sx), h = Math.min(Math.round(rect.h * k), bmp.height - sy);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
  return toDataUrl(await c.convertToBlob({ type: 'image/png' }));
}

// ---------- making a clip ----------
const stamp = () => new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function bookmarkHtml(p, picSrc) {
  return `<div>${picSrc ? `<img src="${esc(picSrc)}" alt="${esc(p.title)}"><br>` : ''}<h3><a href="${esc(p.url)}">${esc(p.title || p.url)}</a></h3>`
    + (p.description ? `<p>${esc(p.description)}</p>` : '') + `<p><small>${esc(p.siteName || '')}</small></p></div>`;
}

/**
 * opts: { tabId, mode, notebook, tags, remark, title, page (already extracted, optional), srcUrl/linkUrl/linkText (menus) }
 * Returns the clip (queued) or null when cancelled.
 */
async function makeClip(opts) {
  const tab = await chrome.tabs.get(opts.tabId);
  const mode = opts.mode;
  let page = opts.page || null, html = '', pics = [], files = [], url = tab.url, title = opts.title;

  if (mode === 'shot' || mode === 'area') {
    const data = await screenshot(tab, mode === 'area');
    if (!data) return null;
    files.push({ name: `Screenshot ${new Date().toISOString().slice(0, 10)}.png`, mime: 'image/png', data });
    title = title || 'Screenshot: ' + (tab.title || url);
  } else if (mode === 'pdf') {
    const b = await fetchBlob(tab.url, MAX_FILE);
    files.push({ name: fileName(tab.url, 'document.pdf').replace(/(\.pdf)?$/i, '.pdf'), mime: 'application/pdf', data: await toDataUrl(b) });
    title = title || fileName(tab.url, tab.title || 'PDF').replace(/\.pdf$/i, '');
  } else if (mode === 'image') {
    const b = await fetchBlob(opts.srcUrl, MAX_PIC);
    files.push({ name: fileName(opts.srcUrl, 'picture.' + (b.type.split('/')[1] || 'jpg')), mime: b.type || 'image/jpeg', data: await toDataUrl(b) });
    title = title || 'Picture from ' + (tab.title || new URL(url).hostname);
  } else if (mode === 'link') {
    url = opts.linkUrl;
    let p = { url, title: opts.linkText || url, description: '', siteName: new URL(url).hostname.replace(/^www\./, ''), image: '' };
    try { // read the linked page's title, summary and picture
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok && /html/.test(res.headers.get('content-type') || '')) {
        const t = (await res.text()).slice(0, 400000);
        const m = re => (t.match(re)?.[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        const mt = n => m(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)`, 'i')) || m(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i'));
        p = { ...p, title: mt('og:title') || m(/<title[^>]*>([^<]*)/i) || p.title, description: mt('og:description') || mt('description'), siteName: mt('og:site_name') || p.siteName, image: mt('og:image') ? new URL(mt('og:image'), url).href : '' };
      }
    } catch { /* keep the plain link */ }
    page = p;
    title = title || p.title;
  } else {
    if (!page) page = await extract(tab.id, mode === 'bookmark' ? 'info' : mode);
    if (page.error) throw new Error(page.error);
    title = title || page.title;
  }

  if (mode === 'bookmark' || mode === 'link') {
    const [pic] = page.image ? await grabPictures([page.image]) : [];
    html = bookmarkHtml(page, pic ? page.image : '');
    pics = pic ? [pic] : [];
  } else if (page?.html !== undefined) {
    html = page.html;
    if (page.byline) html = `<p><i>${esc(page.byline)}</i></p>` + html;
    pics = await grabPictures(page.images || []);
  }
  if (opts.remark?.trim()) html = `<blockquote>${esc(opts.remark.trim()).replace(/\n/g, '<br>')}</blockquote><div><br></div>` + html;

  const clip = { id: uid(), at: Date.now(), kind: mode, title: (title || 'Clip').slice(0, 140), url, html, images: pics, files,
    notebook: (opts.notebook || '').trim() || 'Clips', tags: (opts.tags || []).map(t => String(t).trim()).filter(Boolean), clippedAt: stamp() };
  const q = await get('queue', []);
  q.push(clip); await set('queue', q);
  if (opts.notebook) await set('lastNotebook', opts.notebook.trim());
  return clip;
}

// ---------- handing clips to Steward ----------
async function stewardTabs() { return chrome.tabs.query({ url: STEWARD_MATCH }); }

async function ping(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'ping' }); } catch { return null; }
}

/** Make sure some Steward tab is open with the bridge running; returns its id. */
async function ensureSteward() {
  for (const t of await stewardTabs()) {
    if (t.discarded) { await chrome.tabs.reload(t.id); continue; }
    let p = await ping(t.id);
    if (!p && t.status === 'complete') { // tab was open before the extension was installed
      try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] }); p = await ping(t.id); } catch {}
    }
    if (p) return t.id;
  }
  const existing = await stewardTabs();
  if (existing.length) return existing[0].id; // still loading; it will call in when ready
  const t = await chrome.tabs.create({ url: STEWARD, active: false });
  openedByUs.add(t.id);
  return t.id;
}

// One hand-over at a time, so a clip is never sent to Steward twice at once.
let line = Promise.resolve();
function drain(tabId) { line = line.then(() => drainNow(tabId)).catch(e => console.warn('drain', e)); return line; }

async function drainNow(tabId) {
  const tried = new Set();
  for (;;) {
    const clip = (await get('queue', [])).find(c => !tried.has(c.id));
    if (!clip) break;
    tried.add(clip.id);
    let res;
    try { res = await chrome.tabs.sendMessage(tabId, { type: 'deliver', clip }); }
    catch { res = null; } // Steward still opening: its bridge calls in when ready and the clip goes then
    if (!res) break;
    if (res.ok) {
      await set('queue', (await get('queue', [])).filter(c => c.id !== clip.id));
      const results = await get('results', {});
      results[clip.id] = { ok: true, noteId: res.noteId, notebook: res.notebook, title: clip.title, at: Date.now() };
      for (const k of Object.keys(results)) if (results[k].at < Date.now() - 864e5) delete results[k];
      await set('results', results);
      badge('✓', '#14401c');
    } else badge('!', '#a82b2f', 0);
    waiters.get(clip.id)?.(res); waiters.delete(clip.id);
  }
  if (!(await get('queue', [])).length && openedByUs.has(tabId)) {
    openedByUs.delete(tabId);
    setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
  }
}

/** Queue a clip, hand it to Steward and wait (up to a minute) for Steward to confirm it saved. */
async function clipAndSave(opts) {
  const clip = await makeClip(opts);
  if (!clip) return { ok: false, cancelled: true };
  badge('…', '#6a6d5c', 0);
  const done = new Promise(r => waiters.set(clip.id, r));
  const tabId = await ensureSteward();
  drain(tabId);
  const res = await Promise.race([done, sleep(60000).then(() => ({ ok: false, queued: true }))]);
  if (res.queued) badge('…', '#8a5a2b', 0);
  return { ...res, title: clip.title, notebook: clip.notebook };
}

async function openNote(noteId) {
  const url = STEWARD + (noteId ? '#/note/' + noteId : '');
  const [t] = await stewardTabs();
  if (t) { openedByUs.delete(t.id); await chrome.tabs.update(t.id, { url, active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}

// ---------- messages from the popup and the Steward bridge ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'bridge-ready' && sender.tab) { await drain(sender.tab.id); return {}; }
    if (msg.type === 'preview') return await extract(msg.tabId, msg.mode);
    if (msg.type === 'clip') return await clipAndSave(msg.opts);
    if (msg.type === 'open') { await openNote(msg.noteId); return {}; }
    if (msg.type === 'retry') { const id = await ensureSteward(); drain(id); return {}; }
    return {};
  })().then(reply, e => reply({ ok: false, error: e?.message || String(e) }));
  return true;
});

// ---------- right-click menus and the keyboard shortcut ----------
function menus() {
  chrome.contextMenus.removeAll(() => {
    const add = (id, title, contexts, pdfOnly) => chrome.contextMenus.create({ id, title, contexts, ...(pdfOnly ? { documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*', '*://*/*.PDF', 'file:///*.pdf'] } : {}) });
    add('page', 'Clip this article to Steward', ['page']);
    add('fullpage', 'Clip the full page to Steward', ['page']);
    add('area', 'Screenshot an area to Steward', ['page', 'image', 'selection']);
    add('selection', 'Clip selection to Steward', ['selection']);
    add('image', 'Save this picture to Steward', ['image']);
    add('link', 'Save this link to Steward', ['link']);
    add('pdf', 'Save this PDF to Steward', ['page', 'frame'], true);
  });
}
chrome.runtime.onInstalled.addListener(() => { menus(); retryQueue(); });
chrome.runtime.onStartup.addListener(() => { menus(); retryQueue(); });

async function retryQueue() { if ((await get('queue', [])).length) { const id = await ensureSteward(); drain(id); } }

async function quick(tab, mode, extra = {}) {
  try {
    if (!canScript(tab.url) && !['link', 'image'].includes(mode)) mode = 'shot';
    const res = await clipAndSave({ tabId: tab.id, mode, notebook: await get('lastNotebook', 'Clips'), tags: [], ...extra });
    if (!res.ok && !res.cancelled && !res.queued) throw new Error(res.error || 'not saved');
  } catch (e) { console.warn(e); badge('!', '#a82b2f', 0); }
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const m = { page: 'article', fullpage: 'page', area: 'area', selection: 'selection', image: 'image', link: 'link', pdf: 'pdf' }[info.menuItemId];
  quick(tab, m, { srcUrl: info.srcUrl, linkUrl: info.linkUrl, linkText: info.linkText || info.selectionText });
});
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'clip-now' || !tab) return;
  let mode = 'article';
  try { const p = await extract(tab.id, 'info'); mode = p.isPdf ? 'pdf' : p.hasSelection ? 'selection' : 'article'; } catch {}
  quick(tab, mode);
});
